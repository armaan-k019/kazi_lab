import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db, MODELS, paperMetrics, papers } from "@kazi-lab/db";
import { canonDataset, canonMetric, canonTask } from "./metric-aliases";

// Metric extraction is structured reading of the (table-bearing) text. It uses
// the shared extraction model (now Opus 4.8, moved off Sonnet by choice).
const MODEL = MODELS.extraction;
export const METRIC_EXTRACTION_VERSION = "metrics-v1-2026-06-23";

// Read the FULL table-bearing stored text (not the 40k claim-extraction slice
// that would cut results tables). Cap matches the storage cap.
const TEXT_CAP = 150_000;

// Output budget scales with text length (more text -> more tables/rows). Set
// generously (rows carry a source_excerpt, so JSON is verbose); the cap is a
// backstop that sits under the Opus 4.8 output ceiling. The truncation guard
// is the last line of defense.
const BASE_TOKENS = 12_000;
const TOKENS_PER_KCHAR = 320; // large (150k-char) papers should reach the cap
const MAX_OUTPUT_CAP = 60_000; // backstop, well under Opus 4.8's output ceiling
function metricMaxTokens(textLen: number): number {
  return Math.min(
    MAX_OUTPUT_CAP,
    BASE_TOKENS + Math.round((textLen / 1000) * TOKENS_PER_KCHAR),
  );
}

const SYSTEM_PROMPT = `You extract structured quantitative results from a research paper's text (which includes tables rendered as GitHub-flavored markdown). Produce ONE row per reported number from results, ablation, and comparison TABLES, plus key numbers reported INLINE in the text. Be exhaustive over the tables.

For each number capture:
- method_name: the model/approach the number describes (e.g. "PointNet++", "DGCNN"). For an ablation variant, name the variant.
- is_self: true if it is THIS paper's own proposed method, false if it is a baseline or prior method the paper re-reports.
- task: e.g. "classification", "semantic segmentation", "part segmentation", "3D reconstruction", "novel view synthesis".
- dataset_raw: the dataset exactly as written. dataset_norm: a canonical form (collapse trivial variants: "ModelNet-40"/"ModelNet 40" -> "ModelNet40"; "S3DIS Area 5" -> "S3DIS"; keep the canonical dataset name).
- metric_raw: the metric exactly as written. metric_norm: a short canonical token ("OA"/"overall accuracy" -> "accuracy"; "mAcc"/"mean class accuracy" -> "mean_accuracy"; "mean IoU"/"mIoU" -> "mIoU"; "F1" -> "F1"; "Chamfer distance" -> "chamfer_distance"; "PSNR" -> "PSNR"; "latency"/"inference time" -> "latency"; "FPS" -> "FPS").
- value: the numeric value only (a number, no unit text).
- unit: "%", "ms", "mm", "dB", "fps", etc., or null.
- dispersion: std dev / CI / +- ONLY if reported (store as written, e.g. "0.0249"), else null. Never invent.
- sample_size: n / number of views / number of runs ONLY if reported, else null.
- conditions: qualifying conditions ONLY if reported (e.g. "1 view", "voxel 0.02", "Area 5"), else null.
- source_kind: "table" or "inline_text".
- source_excerpt: the table row or sentence the number came from, at most about 160 characters.
- confidence: "low" | "medium" | "high".

Rules:
- Do NOT invent dispersion, sample_size, or conditions; use null when absent.
- Only include rows that have a real numeric value and an identifiable metric.
- Emit ONE row per distinct (method, dataset, metric, conditions); do not duplicate the same number.
- Keep source_excerpt short (about 160 chars) to stay within length limits.
- Normalize dataset_norm and metric_norm carefully (this is what lets numbers be pooled across papers), but keep the raw forms.

Return ONLY valid JSON (no markdown, no commentary):
{ "metrics": [ { "method_name": "...", "is_self": false, "task": "...", "dataset_raw": "...", "dataset_norm": "...", "metric_raw": "...", "metric_norm": "...", "value": 0, "unit": "... or null", "dispersion": "... or null", "sample_size": "... or null", "conditions": "... or null", "source_kind": "table", "source_excerpt": "...", "confidence": "high" } ] }
If the paper has no quantitative results (e.g. a review with no tables), return { "metrics": [] }.`;

type RawMetric = {
  method_name?: unknown;
  is_self?: unknown;
  task?: unknown;
  dataset_raw?: unknown;
  dataset_norm?: unknown;
  metric_raw?: unknown;
  metric_norm?: unknown;
  value?: unknown;
  unit?: unknown;
  dispersion?: unknown;
  sample_size?: unknown;
  conditions?: unknown;
  source_kind?: unknown;
  source_excerpt?: unknown;
  confidence?: unknown;
};

export type MetricExtractionResult = {
  paperId: string;
  count: number;
  dropped: number;
  truncated: boolean;
  note: string | null;
};

// Extract exactly the FIRST complete JSON object via brace-depth matching
// (string-aware), so trailing prose or a second block after a valid object does
// not break parsing. If the object never closes (truncated output), returns the
// partial so JSON.parse fails and the truncation branch handles it.
function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1].trim() : trimmed;
  const start = body.indexOf("{");
  if (start < 0) return body;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return body.slice(start);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.eE+-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Extract structured metrics for one paper from its upgraded stored text.
// Idempotent (delete-then-insert in a transaction). Non-fatal: a paper with no
// results yields zero rows and is reported, not an error.
export async function extractPaperMetrics(
  paperId: string,
): Promise<MetricExtractionResult> {
  const [paper] = await db
    .select({ id: papers.id, title: papers.title, rawText: papers.rawText })
    .from(papers)
    .where(eq(papers.id, paperId))
    .limit(1);
  if (!paper) throw new Error(`Paper not found: ${paperId}`);

  const text = (paper.rawText ?? "").slice(0, TEXT_CAP);
  if (text.replace(/\s/g, "").length < 200) {
    // No usable text; clear any prior rows and report zero.
    await db.delete(paperMetrics).where(eq(paperMetrics.paperId, paperId));
    return { paperId, count: 0, dropped: 0, truncated: false, note: "no usable text" };
  }

  const client = new Anthropic();
  const response = await client.messages
    .stream({
      model: MODEL,
      max_tokens: metricMaxTokens(text.length),
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: `Title: ${paper.title}\n\nPaper text:\n${text}` },
      ],
    })
    .finalMessage();

  const truncated = response.stop_reason === "max_tokens";
  const block = response.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text : "";

  let parsed: { metrics?: RawMetric[] };
  try {
    parsed = JSON.parse(extractJsonObject(raw)) as { metrics?: RawMetric[] };
  } catch (parseErr) {
    if (truncated) {
      // Truncation broke the JSON: keep prior rows, report cleanly (non-fatal).
      return {
        paperId,
        count: 0,
        dropped: 0,
        truncated: true,
        note: "output truncated; unparseable, prior metrics kept",
      };
    }
    throw new Error(`Failed to parse metric JSON: ${(parseErr as Error).message}`);
  }

  let dropped = 0;
  const rows = (parsed.metrics ?? [])
    .map((m) => {
      const value = num(m.value);
      const metricRaw = str(m.metric_raw) ?? str(m.metric_norm);
      // A valid row needs a real number and an identifiable metric.
      if (value === null || !metricRaw) {
        dropped++;
        return null;
      }
      const sourceKind = m.source_kind === "inline_text" ? "inline_text" : "table";
      const confidence =
        m.confidence === "low" || m.confidence === "medium" || m.confidence === "high"
          ? m.confidence
          : null;
      const task = str(m.task);
      const datasetNorm = str(m.dataset_norm) ?? str(m.dataset_raw);
      const metricNorm = str(m.metric_norm) ?? metricRaw;
      return {
        paperId,
        methodName: str(m.method_name),
        isSelf: typeof m.is_self === "boolean" ? m.is_self : false,
        task,
        datasetRaw: str(m.dataset_raw),
        datasetNorm,
        metricRaw,
        metricNorm,
        datasetCanon: canonDataset(datasetNorm),
        metricCanon: canonMetric(metricNorm),
        taskCanon: canonTask(task),
        value: String(value),
        unit: str(m.unit),
        dispersion: str(m.dispersion),
        sampleSize: str(m.sample_size),
        conditions: str(m.conditions),
        sourceKind,
        sourceExcerpt: str(m.source_excerpt),
        confidence,
        extractionVersion: METRIC_EXTRACTION_VERSION,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // Drop exact duplicate rows (same method/dataset/metric/conditions/value).
  const seen = new Set<string>();
  const deduped = rows.filter((r) => {
    const key = `${r.methodName}|${r.datasetNorm}|${r.metricNorm}|${r.conditions}|${r.value}`;
    if (seen.has(key)) {
      dropped++;
      return false;
    }
    seen.add(key);
    return true;
  });

  // Idempotent: replace this paper's metrics atomically.
  await db.transaction(async (tx) => {
    await tx.delete(paperMetrics).where(eq(paperMetrics.paperId, paperId));
    if (deduped.length > 0) await tx.insert(paperMetrics).values(deduped);
  });

  const noteParts: string[] = [];
  if (truncated) noteParts.push("output truncated; stored partial metrics");
  if (dropped) noteParts.push(`dropped ${dropped} malformed/duplicate row(s)`);
  return {
    paperId,
    count: deduped.length,
    dropped,
    truncated,
    note: noteParts.length ? noteParts.join("; ") : null,
  };
}
