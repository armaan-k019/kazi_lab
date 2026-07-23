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
  external: {
    citedByCount: number | null;
    doi: string | null;
    venue: string | null;
  } | null;
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

export type ChatCitation = { paperId: string; paperTitle: string };
export type ChatUsedChunk = {
  paperTitle: string;
  content: string;
  similarity: number;
  entityType: string;
};
export type ChatResponse = {
  answer: string;
  citations: ChatCitation[];
  usedChunks: ChatUsedChunk[];
  refused: boolean;
};

export type DiscoveryCandidate = {
  openalexId: string;
  title: string;
  year: number | null;
  citedByCount: number | null;
  doi: string | null;
  ingestableUrl: string | null;
  inThisLibrary: boolean;
  inCorpus: boolean;
};
export type ExternalAuthor = { id: string; name: string };

export type GapConnection = {
  type: "referenced" | "cites";
  libraryPaperTitle: string;
};
export type GapCandidate = DiscoveryCandidate & {
  connectionCount: number;
  connections: GapConnection[];
};
export type LibraryGapsResult =
  | { available: false; reason: string }
  | { available: true; candidates: GapCandidate[] };

export type QuestionSearchResult = {
  found: true;
  question: string;
  searchQuery: string;
  candidates: DiscoveryCandidate[];
};
export type PaperContext =
  | { available: false }
  | {
      available: true;
      authors: ExternalAuthor[];
      buildsOn: DiscoveryCandidate[];
      citedBy: DiscoveryCandidate[];
    };

export type CriticContradiction = {
  id: string;
  verdict: string; // genuine | definitional | scope_dependent | overstated
  rationale: string | null;
  confidence: string | null;
  severity: string | null;
  synthesisRationale: string | null;
  fromClaimText: string | null;
  fromPaperTitle: string | null;
  toClaimText: string | null;
  toPaperTitle: string | null;
};
export type CriticFinding = {
  id: string;
  statement: string | null;
  synthesisLabel: string | null;
  labelVerdict: string; // justified | inflated | manufactured
  groundingVerdict: string; // grounded | partially_grounded | overreach
  independenceNote: string | null;
  rationale: string | null;
  confidence: string | null;
  severity: string | null;
};
export type LibraryConference = {
  id: string;
  name: string;
  sourceUrl: string | null;
  sourceKind: string;
  rawSourceText: string | null;
  themes: string[] | null;
  keyDates: string[] | null;
  scopeSummary: string | null;
  synthStatus: string;
  notes: string | null;
};

export type CriticAbstract = {
  title: string | null;
  abstractText: string | null;
  claimToTest: string | null;
  direction: string | null;
  groundedOn: string[] | null;
  conferencesConsidered: string[] | null;
};
export type CriticLatest =
  | { general: true }
  | {
      general: false;
      hasSynthesis: boolean;
      run: {
        id: string;
        createdAt: string;
        completedAt: string | null;
        notes: string | null;
      } | null;
      abstract: CriticAbstract | null;
      contradictions: CriticContradiction[];
      findings: CriticFinding[];
    };

export type RelationType = "supports" | "contradicts" | "extends";

export type SynthesisPaper = {
  id: string;
  title: string;
  publishedAt: string | null;
  claimCount: number;
  claims: { id: string; text: string }[];
  narration: string | null;
  citedByCount: number | null; // from matched OpenAlex record, null if unmatched
  semanticY: number; // PCA first-component coordinate, 0..1 (0.5 if no embedding)
};

export type SynthesisTheme = {
  id: string;
  name: string;
  description: string | null;
  paperIds: string[];
};

export type SynthesisSupport = {
  paperId: string;
  claimId: string | null;
  claimText: string | null;
};

export type SynthesisFinding = {
  id: string;
  statement: string;
  detail: string | null;
  consensus: string | null;
  supports: SynthesisSupport[];
};

export type SynthesisRelation = {
  id: string;
  relationType: string;
  rationale: string | null;
  fromClaimId: string;
  toClaimId: string;
  fromClaimText: string;
  toClaimText: string;
  fromPaperId: string;
  toPaperId: string;
};

export type SynthesisOpenQuestion = {
  id: string;
  question: string;
  rationale: string | null;
  relatedPaperIds: string[];
};

export type SynthesisResults = {
  run:
    | {
        id: string;
        completedAt: string | null;
        paperCount: number | null;
        counts: SynthesisCountSet;
      }
    | null;
  papers: SynthesisPaper[];
  themes: SynthesisTheme[];
  findings: SynthesisFinding[];
  relations: SynthesisRelation[];
  openQuestions: SynthesisOpenQuestion[];
};

// Lab-level cross-domain synthesis (shapes from /api/cross-domain/latest).
export type CrossDomainLevel = "method" | "claim" | "concept";

export type CrossDomainEvidence = {
  id: string;
  libraryName: string;
  kind: "method" | "finding" | "claim";
  ref: string;
  excerpt: string | null;
};

export type CrossDomainVerdict = "confirmed" | "promoted" | "demoted" | "rejected";

export type CrossDomainLink = {
  id: string;
  level: CrossDomainLevel;
  summary: string;
  confidence: string | null;
  isCandidate: boolean;
  source: "synthesis" | "discovery";
  rationale: string | null;
  // The cross-domain Critic's verdict on this link, if the run was critiqued.
  verdict: { verdict: CrossDomainVerdict; rationale: string | null; confidence: string | null } | null;
  libraries: { id: string; name: string }[];
  evidence: CrossDomainEvidence[];
};

export type CrossDomainLatest = {
  eligible: { id: string; name: string }[];
  run: {
    id: string;
    scope: string[];
    notes: string | null;
    createdAt: string;
    completedAt: string | null;
  } | null;
  critique: { id: string; notes: string | null; completedAt: string | null } | null;
  links: CrossDomainLink[];
};

// Experimentalist (shapes from /api/experimentalist/*).
export type ExperimentInputs = {
  abstracts: { id: string; library: string; claim: string }[];
  links: {
    id: string;
    level: string;
    summary: string;
    isCandidate: boolean;
    source: string;
    verdict: string | null;
    libraries: string[];
  }[];
  libraries: { id: string; name: string }[];
};

export type PooledMethod = {
  method: string;
  pooledValue: number;
  pooledFromSelf: boolean;
  conflict: boolean;
};
export type PooledRank = { method: string; meanRank: number; medianRank: number; nPapers: number };
export type PooledWin = { method: string; wins: number; losses: number; winRate: number };

export type MetaKey = {
  dataset: string | null;
  metric: string | null;
  task: string | null;
  conditions: string | null;
  nPapers: number | null;
  nMethods: number | null;
  kinds: {
    best_median?: { higherIsBetter: boolean; methods: PooledMethod[]; conflicts: { method: string; values: number[] }[] };
    rank?: { ranks: PooledRank[] };
    vote_count?: { winRates: PooledWin[] };
    variance_weighted_subset?: { weightedMean: number; note: string; contributing: { method: string; value: number; std: number; paper: string }[] };
  };
};

export type ExperimentInterpretation = {
  verdict: string | null;
  text: string | null;
  caveats: string[];
  unknowns: string[];
  keysCited?: string[];
  findingsCited?: string[];
} | null;

export type ExperimentSpecView = {
  title: string | null;
  objective: string | null;
  design: { arms?: string[]; held_fixed?: string[]; procedure?: string } | null;
  metrics: { measured?: string[]; datasets?: string[]; why?: string } | null;
  confirmCriteria: string | null;
  refuteCriteria: string | null;
  environment: { dependencies?: string[]; datasets?: string[]; hardware?: string; scale_notes?: string } | null;
  verificationHarness: string | null;
  humanDecisions: string[] | null;
  limitations: string | null;
};

export type ExperimentRun = {
  run: {
    id: string;
    inputKind: string;
    claim: string;
    scope: string[];
    status: string;
    notes: string | null;
    completedAt: string | null;
    interpretation: ExperimentInterpretation;
  } | null;
  metaKeys?: MetaKey[];
  qualitative?: { libraryName: string; findings: { findingRef: string | null; excerpt: string | null; note: string | null }[] }[];
  spec?: ExperimentSpecView | null;
};

// Writer (shapes from /api/writer/*).
export type DocumentSection = { key: string; heading: string; body: string; kind: string };
export type WriterDocument = {
  writerRunId: string;
  experimentalistRunId: string;
  claim: string | null;
  title: string | null;
  sections: DocumentSection[];
  provenance: Record<string, string[]> | null;
  conferencesConsidered: string[] | null;
  notes: string | null;
  completedAt: string | null;
};
export type WriterLatest = {
  experimentalistRuns: { id: string; claim: string; completedAt: string | null; hasDocument: boolean }[];
  document: WriterDocument | null;
};

// Research web (shapes from /api/web/*).
export type WebGraphNode = {
  id: string;
  refId: string | null;
  label: string | null;
  community: number | null;
  degree: number | null;
  isBridge: boolean;
};
export type WebGraphEdge = { src: string | null; dst: string | null; kind: string; weight: number };
export type WebCommunity = { index: number; label: string | null; size: number | null };
export type WebAbcCandidate = {
  score: number;
  payload: {
    a_label: string;
    c_label: string;
    a_community?: number;
    c_community?: number;
    path_evidence?: { b_label: string; a_leg_papers: { title: string }[]; c_leg_papers: { title: string }[] }[];
  };
};
export type WebDiscovery = {
  id: string;
  level: string;
  summary: string;
  rationale: string | null;
  verdict: string | null;
  evidence: { kind: string; ref: string; excerpt: string | null }[];
};
export type WebStats = {
  nodes?: { papers: number; claims: number; methods: number; datasets: number; concepts: number; conceptMerges: number; total: number };
  edges?: Record<string, number>;
  projectionEdges?: number;
  citations?: number;
  ari?: { vsLibrariesAll: number; vsLibrariesOnTopic: number | null; note: string };
  orphanReport?: {
    tinyCommunities: { community: number; size: number; papers: string[] }[];
    lowDegreePapers: { title: string; projDegree: number; library: string }[];
  };
};
export type WebLatest = {
  run: { id: string; params: Record<string, unknown>; stats: WebStats; completedAt: string | null } | null;
  communities: WebCommunity[];
  nodes: WebGraphNode[];
  edges: WebGraphEdge[];
  abc: WebAbcCandidate[];
  nodeBridges: { score: number; payload: { title: string; communities: number[] } }[];
  discoveries: WebDiscovery[];
};
