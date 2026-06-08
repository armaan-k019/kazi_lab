// Shapes returned by the /api/scribe routes. Dates are serialized as ISO
// strings over JSON.

export type PaperSummary = {
  id: string;
  title: string;
  authors: string[];
  arxivId: string | null;
  url: string;
  publishedAt: string | null;
  ingestedAt: string;
  claimCount: number;
};

export type Extraction = {
  extractionVersion: string;
  problem: string | null;
  priorWork: string | null;
  method: string | null;
  results: string | null;
  limitations: string | null;
  keyTerms: string[] | null;
  datasetsUsed: string[] | null;
};

export type Claim = {
  id: string;
  text: string;
  sourcePassage: string | null;
  confidence: string | null;
};

export type PaperDetail = {
  paper: {
    id: string;
    title: string;
    arxivId: string | null;
    url: string;
    pdfUrl: string | null;
    abstract: string | null;
    publishedAt: string | null;
    ingestedAt: string;
  };
  extraction: Extraction | null;
  claims: Claim[];
  authors: { name: string; position: number }[];
};

export type IngestResult = {
  paperId: string;
  claimsInserted: number;
  alreadyIngested: boolean;
  linkedExisting?: boolean;
  libraryId?: string;
};

export type Library = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  paperCount: number;
};

export type SynthesisCountSet = {
  themeCount: number;
  findingCount: number;
  relationCount: number;
  openQuestionCount: number;
};

export type SynthesisStatus = {
  runId: string;
  status: "running" | "completed" | "failed";
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  counts: SynthesisCountSet | null;
};

export type SynthesisLatest =
  | ({ runId: string; completedAt: string | null } & SynthesisCountSet)
  | null;
