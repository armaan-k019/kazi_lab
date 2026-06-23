import Anthropic from "@anthropic-ai/sdk";
import { countMarkdownTables } from "./markdown";
import { STORED_TEXT_CAP } from "./types";

// Vision transcription is descriptive structuring (read text + render tables),
// so it uses Sonnet. Best-effort: if rasterization is unavailable in this
// environment, rasterize() throws and the caller falls back to pdf-parse.
const MODEL = "claude-sonnet-4-6";
const MAX_VISION_PAGES = 12; // bound cost; covers most papers' main body
const MAX_TOKENS = 8000;
const RENDER_SCALE = 2.0; // legible table cells

const SYSTEM_PROMPT = `Transcribe this research paper from the page images into clean text in natural reading order. Render every TABLE as a GitHub-flavored markdown table, preserving all rows, columns, and numeric values exactly. Keep section headings. Do not summarize, omit, or invent content. Skip running headers/footers, line numbers, and the reference list. Output only the transcription as markdown, with no preamble.`;

type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: "image/png"; data: string };
};
type TextBlock = { type: "text"; text: string };

// Rasterize a PDF's first pages and transcribe them with Claude vision. Returns
// null if rasterization is not feasible here (so the caller falls back).
export async function transcribePdfWithVision(
  bytes: ArrayBuffer,
): Promise<{ markdown: string; tableCount: number } | null> {
  let images: string[];
  try {
    images = await rasterize(bytes, MAX_VISION_PAGES);
  } catch (e) {
    console.error("PDF rasterization unavailable:", (e as Error).message);
    return null;
  }
  if (images.length === 0) return null;

  const content: (ImageBlock | TextBlock)[] = images.map((data) => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  }));
  content.push({ type: "text", text: "Transcribe these pages now." });

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
  let md = block && block.type === "text" ? block.text.trim() : "";
  if (md.replace(/\s/g, "").length < 200) return null;
  if (md.length > STORED_TEXT_CAP) md = md.slice(0, STORED_TEXT_CAP);
  return { markdown: md, tableCount: countMarkdownTables(md) };
}

// Render PDF pages to PNG (base64) via pdfjs-dist + @napi-rs/canvas. These are
// dynamic imports so a missing/native-incompatible binary throws here rather
// than at module load, letting the caller fall back gracefully.
async function rasterize(bytes: ArrayBuffer, maxPages: number): Promise<string[]> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const count = Math.min(doc.numPages, maxPages);
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    const ctx = canvas.getContext("2d");
    await page.render({
      // pdfjs and @napi-rs/canvas have compatible runtime shapes but distinct
      // TS types, so these are bridged with a structural cast.
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
      canvas: canvas as unknown as HTMLCanvasElement,
    }).promise;
    out.push(canvas.toBuffer("image/png").toString("base64"));
  }
  return out;
}
