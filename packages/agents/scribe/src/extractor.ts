import Anthropic from "@anthropic-ai/sdk";
import type { ArxivPaperData } from "./arxiv-fetcher";

// Bump this whenever the extraction prompt below changes, so stored extractions
// record which prompt produced them.
export const EXTRACTION_VERSION = "v1-2026-06-07";

const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 4096;

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
};

const SYSTEM_PROMPT = `You are a research paper analyzer for kazi-lab, a lab studying spatial AI and clustering. Your job is to read a research paper and extract structured fields that capture what matters about it. Be precise and faithful to the source. Do not hallucinate. If a field isn't determinable from the text, return null or empty.

Extract the following fields from the provided paper:

1. problem: What problem is this paper tackling? (1-3 sentences)
2. prior_work: What does it build on? Name specific prior work or research directions. (1-3 sentences)
3. method: How do they approach it? Be specific about techniques, algorithms, datasets. (3-6 sentences)
4. results: What did they find? Include specific metrics if mentioned. (2-4 sentences)
5. limitations: What do the authors admit doesn't work or is left for future work? (1-3 sentences)
6. key_terms: Important technical terms a reader should know to understand this paper (5-15 terms)
7. datasets_used: Specific named datasets mentioned (list of strings, can be empty)
8. claims: Atomic falsifiable assertions made by the paper. Each claim should be:
   - A single specific statement (not a summary)
   - Falsifiable in principle
   - Sourced from a specific passage in the paper
   - Include: text (the claim), source_passage (the original passage), confidence (the paper's hedging: "demonstrate," "suggest," "show," etc.)
   - Extract 3-8 claims per paper

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
    { "text": "string", "source_passage": "string", "confidence": "string" },
    ...
  ]
}`;

// The raw shape Claude returns (snake_case, matching the prompt schema).
type RawExtraction = {
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
// Strip a leading/trailing fence before parsing.
function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

export async function extractPaperFields(
  paper: ArxivPaperData,
): Promise<ExtractionResult> {
  // Construct lazily so env (ANTHROPIC_API_KEY) is loaded before this runs.
  const client = new Anthropic();

  const userMessage = [
    `Title: ${paper.title}`,
    `Authors: ${paper.authors.join(", ")}`,
    "",
    `Abstract: ${paper.abstract}`,
    "",
    `Full text: ${paper.rawText}`,
  ].join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
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
  };
}
