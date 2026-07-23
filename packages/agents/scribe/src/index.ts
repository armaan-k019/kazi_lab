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
export { embedTexts, embedQuery, EMBEDDING_MODEL } from "./embeddings";
export { embedAndStorePaper, buildPaperSummary } from "./embed-store";
export { retrieveRelevant, type RetrievedChunk } from "./retrieve";
export {
  searchWorkByTitle,
  getWorkByDoi,
  getWorkByArxivId,
  getWork,
  getWorksByIds,
  getCitingWorks,
  getAuthorWorks,
  searchWorks,
  type OpenAlexCandidate,
  type OpenAlexWork,
} from "./openalex";
export {
  shapeCandidates,
  type DiscoveryCandidate,
} from "./external-candidates";
export {
  findLibraryGaps,
  type GapCandidate,
  type GapConnection,
  type LibraryGapsResult,
} from "./gaps";
export {
  searchForOpenQuestion,
  type QuestionSearchResult,
} from "./question-search";
export {
  resolvePaperExternal,
  type ExternalResolution,
  type ResolvablePaper,
} from "./resolve-external";
export { enrichPaperExternal } from "./enrich-store";
export {
  extractPaperMetrics,
  METRIC_EXTRACTION_VERSION,
  type MetricExtractionResult,
} from "./extract-metrics";
// External research integrations (keyless-capable, non-fatal, honestly degrading).
export {
  resolveSemanticScholar,
  fetchReferences,
  fetchCitations,
  semanticScholarKeyStatus,
  type SSPaper,
  type SSNeighbor,
} from "./semantic-scholar";
export {
  conceptnetRelated,
  groundAnalogy,
  conceptnetSlug,
  type AnalogyGrounding,
} from "./conceptnet";
export { datamuseAssociations } from "./datamuse";
export { crossrefWork, type CrossrefWork } from "./crossref";
export { backfillCitations, type BackfillResult } from "./citations-backfill";
