import { XMLParser } from "fast-xml-parser";
import { fetchArxivHtmlText } from "./arxiv-html-fetcher";
import { transcribePdfWithVision } from "./pdf-vision";
import { pdfParseText } from "./pdf-fetcher";
import { fetchWithTimeout } from "./http";
import {
  STORED_TEXT_CAP,
  type FetchOptions,
  type ParsePath,
  type SourcePaperData,
} from "./types";

const ARXIV_API = "http://export.arxiv.org/api/query";
const USER_AGENT = "kazi-lab/0.1 (research)";

// Collapse runs of whitespace (including the newlines arXiv wraps fields with)
// into single spaces.
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// True when the input is an arXiv reference: an arxiv.org URL, or a bare arXiv
// id like "2401.12345" / "2401.12345v2" (a token, not an arbitrary URL that
// merely contains such digits).
export function isArxivInput(input: string): boolean {
  const trimmed = input.trim();
  if (/arxiv\.org/i.test(trimmed)) return true;
  return /^\d{4}\.\d{4,5}(v\d+)?$/.test(trimmed);
}

// Accepts any of: full abs/pdf URLs (with or without protocol or version
// suffix) and bare ids. Returns the version-less id (e.g. "2401.12345").
export function extractArxivId(input: string): string {
  const trimmed = input.trim();
  // New-style ids: 2401.12345 or 2401.12345v2 (4 digits, dot, 4-5 digits).
  const match = trimmed.match(/(\d{4}\.\d{4,5})(v\d+)?/);
  if (!match) {
    throw new Error(
      `Could not parse an arXiv id from "${input}". Expected something like https://arxiv.org/abs/2401.12345 or 2401.12345.`,
    );
  }
  return match[1];
}

// fast-xml-parser returns a single object when there is one child element and
// an array when there are several. Normalize to an array.
function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// arXiv rate-limits and occasionally returns 503. Retry those with exponential
// backoff. Other non-200 responses fail immediately.
async function fetchArxivXml(arxivId: string): Promise<string> {
  const maxAttempts = 4;
  let lastStatus = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const backoffMs = 3000 * 3 ** (attempt - 1); // 3s, 9s, 27s
      console.log(
        `arXiv returned ${lastStatus}; retrying in ${backoffMs / 1000}s (attempt ${attempt + 1}/${maxAttempts})...`,
      );
      await sleep(backoffMs);
    }
    const response = await fetch(`${ARXIV_API}?id_list=${arxivId}`, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (response.ok) {
      return response.text();
    }
    lastStatus = `${response.status} ${response.statusText}`;
    if (response.status !== 429 && response.status !== 503) {
      throw new Error(
        `arXiv API returned ${lastStatus} for id ${arxivId}.`,
      );
    }
  }
  throw new Error(
    `arXiv API still unavailable (${lastStatus}) for id ${arxivId} after ${maxAttempts} attempts.`,
  );
}

export async function fetchArxivPaper(
  arxivUrl: string,
  opts: FetchOptions = {},
): Promise<SourcePaperData> {
  const arxivId = extractArxivId(arxivUrl);

  const xml = await fetchArxivXml(arxivId);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const parsed = parser.parse(xml);

  const entry = parsed?.feed?.entry;
  if (!entry) {
    throw new Error(`arXiv returned no entry for id ${arxivId}. Paper not found.`);
  }
  // arXiv signals a bad id with an entry whose id points at its error endpoint.
  if (typeof entry.id === "string" && entry.id.includes("api/errors")) {
    throw new Error(
      `arXiv could not find paper ${arxivId}: ${normalizeWhitespace(String(entry.summary ?? "not found"))}`,
    );
  }

  const title = normalizeWhitespace(String(entry.title ?? ""));
  const abstract = normalizeWhitespace(String(entry.summary ?? ""));

  const authors = toArray(entry.author)
    .map((a: { name?: unknown }) => normalizeWhitespace(String(a?.name ?? "")))
    .filter((name: string) => name.length > 0);

  let publishedAt: Date | null = null;
  if (entry.published) {
    const parsedDate = new Date(String(entry.published));
    publishedAt = Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }

  // Prefer the pdf link arXiv advertises; fall back to the conventional path.
  const links = toArray(entry.link);
  const pdfLink = links.find(
    (l: Record<string, unknown>) =>
      l["@_title"] === "pdf" || l["@_type"] === "application/pdf",
  );
  const pdfUrl =
    (pdfLink && String(pdfLink["@_href"])) ||
    `https://arxiv.org/pdf/${arxivId}`;

  const url = `https://arxiv.org/abs/${arxivId}`;

  // Full text, best-effort and table-aware, with graceful fallback. Order:
  //   1. arXiv HTML (tables as GFM markdown) - the primary, reliable win
  //   2. vision transcription of the PDF (opt-in; tables as markdown)
  //   3. pdf-parse of the PDF (full flat text; tables flattened)
  //   4. title + abstract only (older papers with none of the above)
  // arXiv metadata stays high-confidence regardless of the full-text path.
  let rawText = `${title}\n\n${abstract}`;
  let parsePath: ParsePath = "abstract_only";
  let tableCount = 0;

  const html = await fetchArxivHtmlText(arxivId).catch(() => null);
  if (html) {
    rawText = `${title}\n\n${html.markdown}`;
    parsePath = "arxiv_html";
    tableCount = html.tableCount;
  } else {
    // Fetch the PDF bytes once for the vision and/or pdf-parse fallbacks.
    const bytes = await fetchWithTimeout(pdfUrl)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null);
    const vision =
      opts.vision && bytes ? await transcribePdfWithVision(bytes).catch(() => null) : null;
    if (vision) {
      rawText = `${title}\n\n${vision.markdown}`;
      parsePath = "vision";
      tableCount = vision.tableCount;
    } else if (bytes) {
      const flat = await pdfParseText(bytes).catch(() => null);
      if (flat) {
        rawText = `${title}\n\n${flat}`.slice(0, STORED_TEXT_CAP);
        parsePath = "pdf_parse_fallback";
      }
    }
  }

  return {
    sourceType: "arxiv",
    arxivId,
    title,
    authors,
    abstract,
    publishedAt,
    url,
    pdfUrl,
    rawText,
    metadataConfidence: "high",
    parsePath,
    tableCount,
  };
}
