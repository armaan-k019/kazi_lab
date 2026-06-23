// The uniform shape every source handler returns, so the extractor and ingest
// logic work the same regardless of where a paper came from.
export type SourceType = "arxiv" | "pdf" | "html";

// Which parse path produced the stored text, for coverage measurement.
//   arxiv_html         - arXiv HTML full text, tables as GFM markdown
//   vision             - Claude vision transcription of rasterized PDF pages
//   readability_tables - Readability prose + tables converted to markdown
//   pdf_parse_fallback - pdf-parse flat text (tables flattened)
//   abstract_only      - title + abstract only (arXiv with no full text)
export type ParsePath =
  | "arxiv_html"
  | "vision"
  | "readability_tables"
  | "pdf_parse_fallback"
  | "abstract_only";

export type SourcePaperData = {
  sourceType: SourceType;
  arxivId: string | null; // null for non-arxiv sources
  title: string;
  authors: string[];
  abstract: string | null; // may be null where there's no clear abstract
  publishedAt: Date | null;
  url: string; // canonical URL
  pdfUrl: string | null;
  rawText: string; // stored text (table-aware where the parse path supports it)
  // "high" for arxiv (metadata from the arXiv API), "inferred" for pdf/html
  // (title/authors/date are derived by Claude during extraction).
  metadataConfidence: "high" | "inferred";
  parsePath: ParsePath; // which path produced rawText (provenance)
  tableCount: number; // number of tables detected in rawText
};

// Options that steer the (best-effort) richer parse paths.
export type FetchOptions = {
  // Attempt the Claude vision transcription for PDFs / HTML-less arXiv. Off by
  // default because it is the expensive path; the cheap paths (arXiv HTML,
  // Readability tables, pdf-parse) run regardless.
  vision?: boolean;
};

// Cap fed to the extractor's Claude call (preserves the prior ~40k extraction
// input size now that stored text can be larger). The extractor slices to this.
export const RAW_TEXT_CAP = 40_000;

// Cap on the STORED text. Raised well above the extractor cap so results and
// ablation tables (often mid-paper, past ~40k chars) are retained in the stored
// text for the downstream quantitative meta-analysis. References are stripped
// from arXiv HTML before storage to spend this budget on content, not citations.
export const STORED_TEXT_CAP = 150_000;
