export { ingestPaper } from "./ingest";
export {
  synthesizeLibrary,
  createSynthesisRun,
  runSynthesis,
  type SynthesisCounts,
} from "./synthesize";
export { fetchSource } from "./fetch-source";
export { fetchArxivPaper, isArxivInput } from "./arxiv-fetcher";
export { fetchPdfPaper } from "./pdf-fetcher";
export { fetchHtmlPaper } from "./html-fetcher";
export {
  extractPaperFields,
  EXTRACTION_VERSION,
  type ExtractionResult,
  type InferredMetadata,
} from "./extractor";
export type { SourcePaperData, SourceType } from "./types";
