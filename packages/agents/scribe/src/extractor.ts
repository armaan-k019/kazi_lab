import Anthropic from "@anthropic-ai/sdk";
import type { SourcePaperData } from "./types";

// Bump this whenever the extraction prompt below changes, so stored extractions
// record which prompt produced them.
export const EXTRACTION_VERSION = "v3-2026-06-08";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4096;

export type InferredMetadata = {
  title: string;
  authors: string[];
  publishedAt: Date | null;
};

export type ExtractionResult = {
  extractionVersion: string;
  problem: string | null;
  priorWork: string | null;
  method: string | null;
  results: string | null;
  limitations: string | null;
  keyTerms: string[];
  datasetsUsed: string[];
  claims: Array<{ text: string; sourcePassage: string; confidence: string }>;
  // Present only for inferred sources (PDF/HTML); null for arXiv.
  inferredMetadata: InferredMetadata | null;
};

const BASE_FIELDS = `Extract the following fields:

1. problem: What problem is this work tackling? (1-3 sentences)
2. prior_work: What does it build on? Name specific prior work or research directions. (1-3 sentences)
3. method: How do they approach it? Be specific about techniques, algorithms, datasets. (3-6 sentences)
4. results: What did they find? Include specific metrics if mentioned. (2-4 sentences)
5. limitations: What do the authors admit doesn't work or is left for future work? (1-3 sentences)
6. key_terms: Important technical terms a reader should know (5-15 terms)
7. datasets_used: Specific named datasets mentioned (list of strings, can be empty)
8. claims: Atomic falsifiable assertions made by the work. Each claim should be:
   - A single specific statement (not a summary)
   - Falsifiable in principle
   - Sourced from a specific passage
   - Include: text (the claim), source_passage (the original passage), confidence (the hedging used: "demonstrate," "suggest," "show," etc.)
   - Extract 3-8 claims`;

const ARXIV_SYSTEM_PROMPT = `You are a research paper analyzer for kazi-lab, a lab studying spatial AI and clustering. Read the provided paper and extract structured fields. Be precise and faithful to the source. Do not hallucinate. If a field isn't determinable, return null or empty.

${BASE_FIELDS}

Return ONLY valid JSON matching this schema (no markdown, no commentary):

{
  "problem": "string or null",
  "prior_work": "string or null",
  "method": "string or null",
  "results": "string or null",
  "limitations": "string or null",
  "key_terms": ["string", ...],
  "datasets_used": ["string", ...],
  "claims": [
    { "text": "string", "source_passage": "string", "confidence": "string" }
  ]
}`;

const INFERRED_SYSTEM_PROMPT = `You are a research analyzer for kazi-lab, a lab studying spatial AI and clustering. The provided text was extracted from a PDF or web page, so it has NO reliable metadata. Read it, infer its metadata, and extract structured fields. Be precise and faithful to the source. Do not hallucinate. If a field isn't determinable, return null or empty.

First, infer the work's metadata from the content:
- title: the most likely title of the work
- authors: array of author names if determinable, otherwise an empty array
- published_at: the publication date as "YYYY-MM-DD" if determinable, otherwise null

Then extract the same fields as for a paper.

${BASE_FIELDS}

Return ONLY valid JSON matching this schema (no markdown, no commentary):

{
  "inferred_metadata": {
    "title": "string",
    "authors": ["string", ...],
    "published_at": "YYYY-MM-DD or null"
  },
  "problem": "string or null",
  "prior_work": "string or null",
  "method": "string or null",
  "results": "string or null",
  "limitations": "string or null",
  "key_terms": ["string", ...],
  "datasets_used": ["string", ...],
  "claims": [
    { "text": "string", "source_passage": "string", "confidence": "string" }
  ]
}`;

// The raw shape Claude returns (snake_case, matching the prompt schema).
type RawExtraction = {
  inferred_metadata?: {
    title?: string | null;
    authors?: string[] | null;
    published_at?: string | null;
  };
  problem: string | null;
  prior_work: string | null;
  method: string | null;
  results: string | null;
  limitations: string | null;
  key_terms: string[];
  datasets_used: string[];
  claims: Array<{ text: string; source_passage: string; confidence: string }>;
};

// Models occasionally wrap JSON in a markdown fence despite instructions.
function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function extractPaperFields(
  paper: SourcePaperData,
): Promise<ExtractionResult> {
  // Construct lazily so env (ANTHROPIC_API_KEY) is loaded before this runs.
  const client = new Anthropic();

  const infer = paper.metadataConfidence === "inferred";

  const userMessage = infer
    ? [
        paper.title ? `Title hint (may be wrong, verify against the text): ${paper.title}` : "",
        `Source: ${paper.url}`,
        "",
        `Extracted text:`,
        paper.rawText,
      ]
        .filter(Boolean)
        .join("\n")
    : [
        `Title: ${paper.title}`,
        `Authors: ${paper.authors.join(", ")}`,
        "",
        `Abstract: ${paper.abstract ?? ""}`,
        "",
        `Full text: ${paper.rawText}`,
      ].join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: infer ? INFERRED_SYSTEM_PROMPT : ARXIV_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const rawText = textBlock && textBlock.type === "text" ? textBlock.text : "";

  let parsed: RawExtraction;
  try {
    parsed = JSON.parse(stripJsonFence(rawText)) as RawExtraction;
  } catch (error) {
    throw new Error(
      `Failed to parse Claude extraction as JSON: ${(error as Error).message}\n\nRaw response:\n${rawText}`,
    );
  }

  let inferredMetadata: InferredMetadata | null = null;
  if (infer && parsed.inferred_metadata) {
    inferredMetadata = {
      title: (parsed.inferred_metadata.title ?? "").trim(),
      authors: (parsed.inferred_metadata.authors ?? []).filter(
        (a) => typeof a === "string" && a.trim().length > 0,
      ),
      publishedAt: parseDate(parsed.inferred_metadata.published_at),
    };
  }

  return {
    extractionVersion: EXTRACTION_VERSION,
    problem: parsed.problem ?? null,
    priorWork: parsed.prior_work ?? null,
    method: parsed.method ?? null,
    results: parsed.results ?? null,
    limitations: parsed.limitations ?? null,
    keyTerms: parsed.key_terms ?? [],
    datasetsUsed: parsed.datasets_used ?? [],
    claims: (parsed.claims ?? []).map((c) => ({
      text: c.text,
      sourcePassage: c.source_passage,
      confidence: c.confidence,
    })),
    inferredMetadata,
  };
}
