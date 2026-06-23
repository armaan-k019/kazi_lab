import { PDFParse } from "pdf-parse";
import { fetchWithTimeout } from "./http";
import { sanitizeText } from "./markdown";
import { transcribePdfWithVision } from "./pdf-vision";
import {
  STORED_TEXT_CAP,
  type FetchOptions,
  type SourcePaperData,
} from "./types";

// Below this many non-whitespace characters we assume extraction failed (e.g. a
// scanned, image-only PDF). We do not attempt OCR.
const MIN_USABLE_CHARS = 200;

// Core pdf-parse pass: returns the flat extracted text (tables flattened), or
// throws if too little text came out. Shared by the PDF path and the arXiv
// PDF fallback.
export async function pdfParseText(bytes: ArrayBuffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  let text: string;
  try {
    const result = await parser.getText();
    text = result.text ?? "";
  } catch (error) {
    throw new Error(`Could not parse PDF: ${(error as Error).message}`);
  } finally {
    await parser.destroy().catch(() => {});
  }
  const content = sanitizeText(text).trim();
  if (content.replace(/\s/g, "").length < MIN_USABLE_CHARS) {
    throw new Error(
      "Could not extract text from PDF; it may be scanned or image-based (OCR is not supported).",
    );
  }
  return content;
}

export async function fetchPdfPaper(
  url: string,
  // The router may already have fetched the bytes while inspecting Content-Type.
  prefetched?: ArrayBuffer,
  opts: FetchOptions = {},
): Promise<SourcePaperData> {
  let bytes = prefetched;
  if (!bytes) {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      throw new Error(
        `Could not fetch PDF: ${response.status} ${response.statusText}.`,
      );
    }
    bytes = await response.arrayBuffer();
  }

  let rawText: string;
  let parsePath: SourcePaperData["parsePath"];
  let tableCount = 0;

  // Best-effort vision pass first (renders tables as markdown). Falls back to
  // flat pdf-parse if vision is unavailable or fails.
  const vision = opts.vision ? await transcribePdfWithVision(bytes).catch(() => null) : null;
  if (vision) {
    rawText = vision.markdown;
    parsePath = "vision";
    tableCount = vision.tableCount;
  } else {
    const content = await pdfParseText(bytes);
    rawText = content.slice(0, STORED_TEXT_CAP);
    parsePath = "pdf_parse_fallback";
  }

  // Best-effort title hint from the first substantial line; the extractor
  // finalizes title/authors/date.
  const firstLine =
    rawText
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 8) ?? "";

  return {
    sourceType: "pdf",
    arxivId: null,
    title: firstLine.slice(0, 300),
    authors: [],
    abstract: null,
    publishedAt: null,
    url,
    pdfUrl: url,
    rawText,
    metadataConfidence: "inferred",
    parsePath,
    tableCount,
  };
}
