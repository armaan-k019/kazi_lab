import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@kazi-lab/db";
import { countMarkdownTables } from "./markdown";
import { STORED_TEXT_CAP } from "./types";

// Vision transcription is descriptive structuring (read text + render tables).
// It uses the shared extraction model (now Opus 4.8, moved off Sonnet by
// choice). Rasterization runs in an isolated child process so a native
// pdfjs/canvas crash skips the paper instead of aborting the run.
const MODEL = MODELS.extraction;
const MAX_VISION_PAGES = 12; // bound cost; covers most papers' main body
const MAX_TOKENS = 8000;
const RENDER_SCALE = 2.0; // legible table cells
const RASTER_TIMEOUT_MS = 90_000; // a hung rasterization must not stall the run

const WORKER_PATH = fileURLToPath(
  new URL("./rasterize-worker.mjs", import.meta.url),
);

const SYSTEM_PROMPT = `Transcribe this research paper from the page images into clean text in natural reading order. Render every TABLE as a GitHub-flavored markdown table, preserving all rows, columns, and numeric values exactly. Keep section headings. Do not summarize, omit, or invent content. Skip running headers/footers, line numbers, and the reference list. Output only the transcription as markdown, with no preamble.`;

type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: "image/png"; data: string };
};
type TextBlock = { type: "text"; text: string };

// Rasterize a PDF's first pages and transcribe them with Claude vision. Returns
// null if rasterization fails (crash, timeout, or unsupported), so the caller
// falls back to pdf-parse for that paper.
export async function transcribePdfWithVision(
  bytes: ArrayBuffer,
): Promise<{ markdown: string; tableCount: number } | null> {
  const images = await rasterizeIsolated(bytes, MAX_VISION_PAGES);
  if (images.length === 0) return null;

  const content: (ImageBlock | TextBlock)[] = images.map((data) => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  }));
  content.push({ type: "text", text: "Transcribe these pages now." });

  // Transcription errors (API failure, content filter, etc.) are also a vision
  // failure: return null so the caller falls back to pdf-parse for this paper.
  let md = "";
  try {
    const client = new Anthropic();
    const response = await client.messages
      .stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      })
      .finalMessage();
    const block = response.content.find((b) => b.type === "text");
    md = block && block.type === "text" ? block.text.trim() : "";
  } catch (e) {
    console.error("Vision transcription failed:", (e as Error).message);
    return null;
  }
  if (md.replace(/\s/g, "").length < 200) return null;
  if (md.length > STORED_TEXT_CAP) md = md.slice(0, STORED_TEXT_CAP);
  return { markdown: md, tableCount: countMarkdownTables(md) };
}

// Rasterize in a child process. A native crash (segfault) or hang there cannot
// be caught by a same-process try/catch, so we spawn a separate node process,
// give it a timeout, and treat any non-zero/killed exit as a clean failure
// (empty result -> caller falls back). Returns base64 PNGs in page order.
async function rasterizeIsolated(
  bytes: ArrayBuffer,
  maxPages: number,
): Promise<string[]> {
  let work: string;
  try {
    work = mkdtempSync(join(tmpdir(), "kazi-raster-"));
  } catch {
    return [];
  }
  const pdfPath = join(work, "in.pdf");
  try {
    writeFileSync(pdfPath, Buffer.from(bytes));
    const exit = await runWorker([
      WORKER_PATH,
      pdfPath,
      work,
      String(maxPages),
      String(RENDER_SCALE),
    ]);
    if (exit !== 0) {
      console.error(`PDF rasterization failed (worker exit ${exit}); skipping vision.`);
      return [];
    }
    return readdirSync(work)
      .filter((f) => f.endsWith(".png"))
      .sort()
      .map((f) => readFileSync(join(work, f)).toString("base64"));
  } catch (e) {
    console.error("PDF rasterization error:", (e as Error).message);
    return [];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Spawn the worker and resolve its exit code. Times out (SIGKILL) so a hung
// rasterization cannot stall the batch. Never rejects.
function runWorker(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "ignore", "inherit"],
    });
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124); // timeout
    }, RASTER_TIMEOUT_MS);
    // A segfault arrives as a signal (e.g. SIGSEGV) with code null.
    child.on("exit", (code, signal) => finish(signal ? 137 : (code ?? 1)));
    child.on("error", () => finish(1));
  });
}
