import { PDFParse } from "pdf-parse";
import { fetchWithTimeout } from "./http";
import { RAW_TEXT_CAP, type SourcePaperData } from "./types";

// Below this many non-whitespace characters we assume extraction failed (e.g. a
// scanned, image-only PDF). We do not attempt OCR.
const MIN_USABLE_CHARS = 200;

export async function fetchPdfPaper(
  url: string,
  // The router may already have fetched the bytes while inspecting Content-Type.
  prefetched?: ArrayBuffer,
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

  const content = text.trim();
  if (content.replace(/\s/g, "").length < MIN_USABLE_CHARS) {
    throw new Error(
      "Could not extract text from PDF; it may be scanned or image-based (OCR is not supported).",
    );
  }

  // Cap to control token cost; the extractor infers metadata from this text.
  const rawText = content.slice(0, RAW_TEXT_CAP);

  // Best-effort title hint from the first substantial line; the extractor
  // finalizes title/authors/date.
  const firstLine =
    content
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
  };
}
