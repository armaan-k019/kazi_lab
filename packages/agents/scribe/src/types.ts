// The uniform shape every source handler returns, so the extractor and ingest
// logic work the same regardless of where a paper came from.
export type SourceType = "arxiv" | "pdf" | "html";

export type SourcePaperData = {
  sourceType: SourceType;
  arxivId: string | null; // null for non-arxiv sources
  title: string;
  authors: string[];
  abstract: string | null; // may be null where there's no clear abstract
  publishedAt: Date | null;
  url: string; // canonical URL
  pdfUrl: string | null;
  rawText: string; // extracted full text (title + abstract for arxiv, as before)
  // "high" for arxiv (metadata from the arXiv API), "inferred" for pdf/html
  // (title/authors/date are derived by Claude during extraction).
  metadataConfidence: "high" | "inferred";
};

// Cap extracted text length for non-arXiv sources to control token cost. The
// first ~40k characters comfortably cover a paper's substance.
export const RAW_TEXT_CAP = 40_000;
