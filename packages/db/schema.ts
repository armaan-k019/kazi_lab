import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// voyage-3.5-lite outputs 1024-dimensional embeddings by default (verified
// against Voyage docs: supported dims 256, 512, 1024 default, 2048). The
// pgvector column dimension must match this exactly.
export const EMBEDDING_DIM = 1024;

export const papers = pgTable("papers", {
  id: uuid("id").primaryKey().defaultRandom(),
  arxivId: text("arxiv_id").unique(),
  title: text("title").notNull(),
  authors: text("authors")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  abstract: text("abstract"),
  publishedAt: timestamp("published_at"),
  url: text("url").notNull(),
  pdfUrl: text("pdf_url"),
  rawText: text("raw_text"),
  // Parse provenance for the stored text (table-aware ingestion): which path
  // produced raw_text and how many tables it preserved. Used for coverage.
  parsePath: text("parse_path"), // arxiv_html | vision | readability_tables | pdf_parse_fallback | abstract_only
  tableCount: integer("table_count"),
  ingestedAt: timestamp("ingested_at").notNull().defaultNow(),
  lastProcessedAt: timestamp("last_processed_at"),
});

export const extractions = pgTable("extractions", {
  id: uuid("id").primaryKey().defaultRandom(),
  paperId: uuid("paper_id")
    .notNull()
    .references(() => papers.id, { onDelete: "cascade" }),
  extractionVersion: text("extraction_version").notNull(),
  problem: text("problem"),
  priorWork: text("prior_work"),
  method: text("method"),
  results: text("results"),
  limitations: text("limitations"),
  keyTerms: text("key_terms")
    .array()
    .default(sql`'{}'::text[]`),
  datasetsUsed: text("datasets_used")
    .array()
    .default(sql`'{}'::text[]`),
  extractedAt: timestamp("extracted_at").notNull().defaultNow(),
});

export const claims = pgTable("claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  paperId: uuid("paper_id")
    .notNull()
    .references(() => papers.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  sourcePassage: text("source_passage"),
  confidence: text("confidence"),
  extractedAt: timestamp("extracted_at").notNull().defaultNow(),
});

export const authors = pgTable("authors", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  affiliation: text("affiliation"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const paperAuthors = pgTable(
  "paper_authors",
  {
    paperId: uuid("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => authors.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (table) => [primaryKey({ columns: [table.paperId, table.authorId] })],
);

export const citations = pgTable("citations", {
  id: uuid("id").primaryKey().defaultRandom(),
  citingPaperId: uuid("citing_paper_id")
    .notNull()
    .references(() => papers.id, { onDelete: "cascade" }),
  citedPaperId: uuid("cited_paper_id").references(() => papers.id, {
    onDelete: "set null",
  }),
  citedTitle: text("cited_title").notNull(),
  citedArxivId: text("cited_arxiv_id"),
  context: text("context"),
});

export const annotations = pgTable("annotations", {
  id: uuid("id").primaryKey().defaultRandom(),
  paperId: uuid("paper_id").references(() => papers.id, {
    onDelete: "cascade",
  }),
  claimId: uuid("claim_id").references(() => claims.id, {
    onDelete: "cascade",
  }),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Libraries: named collections of papers. A paper can belong to many libraries
// (ingest once, link to many). "general" is the default, undeletable library.
// ---------------------------------------------------------------------------

export const libraries = pgTable("libraries", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  // Richer research context (all optional; a library with none set behaves
  // exactly as before). userNotes is a private scratchpad and is NEVER sent to
  // any model call.
  researchFocus: text("research_focus"),
  hypothesis: text("hypothesis"),
  userNotes: text("user_notes"),
  targetVenueType: text("target_venue_type"), // workshop | full paper | journal | poster | other
  status: text("status"), // exploring | drafting | proposed
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Conferences a library targets. Each may carry an optional source (a CFP link,
// pasted PDF text, or pasted text) that is synthesized into themes/scope/dates.
// HARD BOUNDARY: conference sources are context only. They are NEVER inserted
// into papers/extractions/claims/embeddings and never enter Scribe synthesis.
export const libraryConferences = pgTable("library_conferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  libraryId: uuid("library_id")
    .notNull()
    .references(() => libraries.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sourceUrl: text("source_url"),
  sourceKind: text("source_kind").notNull().default("none"), // url | pdf | text | none
  rawSourceText: text("raw_source_text"),
  themes: text("themes").array().default(sql`'{}'::text[]`),
  keyDates: text("key_dates").array().default(sql`'{}'::text[]`),
  scopeSummary: text("scope_summary"),
  synthStatus: text("synth_status").notNull().default("none"), // none | synthesized | failed
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const paperLibraries = pgTable(
  "paper_libraries",
  {
    paperId: uuid("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    libraryId: uuid("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.paperId, table.libraryId] })],
);

// ---------------------------------------------------------------------------
// Synthesis layer: cross-paper themes, findings, and typed relations between
// claims, each tied to the synthesis run that produced it (for versioning).
// ---------------------------------------------------------------------------

export const synthesisRuns = pgTable("synthesis_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The library this run synthesized over (null = legacy/whole-corpus runs).
  libraryId: uuid("library_id").references(() => libraries.id, {
    onDelete: "cascade",
  }),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  status: text("status").notNull().default("running"), // running | completed | failed
  paperCount: integer("paper_count"),
  model: text("model"),
  error: text("error"),
  notes: text("notes"),
});

export const themes = pgTable("themes", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  synthesisRunId: uuid("synthesis_run_id")
    .notNull()
    .references(() => synthesisRuns.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const findings = pgTable("findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  statement: text("statement").notNull(),
  detail: text("detail"),
  // consensus | contested | single-source: how well-supported across the library.
  consensus: text("consensus"),
  synthesisRunId: uuid("synthesis_run_id")
    .notNull()
    .references(() => synthesisRuns.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const paperThemes = pgTable(
  "paper_themes",
  {
    paperId: uuid("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    themeId: uuid("theme_id")
      .notNull()
      .references(() => themes.id, { onDelete: "cascade" }),
    relevance: text("relevance"),
  },
  (table) => [primaryKey({ columns: [table.paperId, table.themeId] })],
);

export const findingPapers = pgTable(
  "finding_papers",
  {
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    paperId: uuid("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    supportingClaimId: uuid("supporting_claim_id").references(() => claims.id, {
      onDelete: "set null",
    }),
  },
  (table) => [primaryKey({ columns: [table.findingId, table.paperId] })],
);

export const claimRelations = pgTable("claim_relations", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromClaimId: uuid("from_claim_id")
    .notNull()
    .references(() => claims.id, { onDelete: "cascade" }),
  toClaimId: uuid("to_claim_id")
    .notNull()
    .references(() => claims.id, { onDelete: "cascade" }),
  relationType: text("relation_type").notNull(), // supports | contradicts | extends
  rationale: text("rationale"),
  synthesisRunId: uuid("synthesis_run_id")
    .notNull()
    .references(() => synthesisRuns.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Gaps the corpus raises but does not answer.
export const openQuestions = pgTable("open_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  synthesisRunId: uuid("synthesis_run_id")
    .notNull()
    .references(() => synthesisRuns.id, { onDelete: "cascade" }),
  libraryId: uuid("library_id")
    .notNull()
    .references(() => libraries.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  rationale: text("rationale"),
  relatedPaperIds: uuid("related_paper_ids")
    .array()
    .default(sql`'{}'::uuid[]`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// A short, precomputed positioning paragraph per (paper, synthesis run): where
// the paper sits in this library's web (what it extends, what contradicts it,
// its distinct contribution). Supplementary — a run is usable without it.
export const paperNarrations = pgTable("paper_narrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  synthesisRunId: uuid("synthesis_run_id")
    .notNull()
    .references(() => synthesisRuns.id, { onDelete: "cascade" }),
  paperId: uuid("paper_id")
    .notNull()
    .references(() => papers.id, { onDelete: "cascade" }),
  narration: text("narration").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Vector embeddings of claims and paper-level summaries (pgvector). entity_id
// is the claim or paper id; paper_id is always the owning paper so retrieval
// can scope by library via paper_libraries. content is the exact embedded text.
export const embeddings = pgTable(
  "embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type").notNull(), // claim | paper
    entityId: uuid("entity_id").notNull(),
    paperId: uuid("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }).notNull(),
    model: text("model").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // One embedding per (entity_type, entity_id); re-embedding replaces it.
    uniqueIndex("embeddings_entity_uq").on(table.entityType, table.entityId),
    // Approximate-nearest-neighbor search via HNSW with cosine distance.
    index("embeddings_hnsw_cos_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

export type Paper = typeof papers.$inferSelect;
export type NewPaper = typeof papers.$inferInsert;

export type Extraction = typeof extractions.$inferSelect;
export type NewExtraction = typeof extractions.$inferInsert;

export type Claim = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;

export type Author = typeof authors.$inferSelect;
export type NewAuthor = typeof authors.$inferInsert;

export type PaperAuthor = typeof paperAuthors.$inferSelect;
export type NewPaperAuthor = typeof paperAuthors.$inferInsert;

export type Citation = typeof citations.$inferSelect;
export type NewCitation = typeof citations.$inferInsert;

export type Annotation = typeof annotations.$inferSelect;
export type NewAnnotation = typeof annotations.$inferInsert;

export type Library = typeof libraries.$inferSelect;
export type NewLibrary = typeof libraries.$inferInsert;

export type PaperLibrary = typeof paperLibraries.$inferSelect;
export type NewPaperLibrary = typeof paperLibraries.$inferInsert;

export type SynthesisRun = typeof synthesisRuns.$inferSelect;
export type NewSynthesisRun = typeof synthesisRuns.$inferInsert;

export type Theme = typeof themes.$inferSelect;
export type NewTheme = typeof themes.$inferInsert;

export type Finding = typeof findings.$inferSelect;
export type NewFinding = typeof findings.$inferInsert;

export type PaperTheme = typeof paperThemes.$inferSelect;
export type NewPaperTheme = typeof paperThemes.$inferInsert;

export type FindingPaper = typeof findingPapers.$inferSelect;
export type NewFindingPaper = typeof findingPapers.$inferInsert;

export type ClaimRelation = typeof claimRelations.$inferSelect;
export type NewClaimRelation = typeof claimRelations.$inferInsert;

export type OpenQuestion = typeof openQuestions.$inferSelect;
export type NewOpenQuestion = typeof openQuestions.$inferInsert;

export type PaperNarration = typeof paperNarrations.$inferSelect;
export type NewPaperNarration = typeof paperNarrations.$inferInsert;

export type Embedding = typeof embeddings.$inferSelect;
export type NewEmbedding = typeof embeddings.$inferInsert;

// External identity + enrichment for a paper (discovery layer, not first-class
// corpus data). One row per paper per source; v1 source is "openalex".
export const paperExternal = pgTable(
  "paper_external",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paperId: uuid("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // openalex
    openalexId: text("openalex_id"),
    doi: text("doi"),
    citedByCount: integer("cited_by_count"),
    venue: text("venue"),
    authoritativeTitle: text("authoritative_title"),
    authoritativeYear: integer("authoritative_year"),
    matchStatus: text("match_status").notNull(), // matched | unmatched | ambiguous
    matchScore: numeric("match_score"),
    authorOpenalexIds: text("author_openalex_ids")
      .array()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("paper_external_paper_source_uq").on(
      table.paperId,
      table.source,
    ),
  ],
);

export type PaperExternal = typeof paperExternal.$inferSelect;
export type NewPaperExternal = typeof paperExternal.$inferInsert;

// The Critic audits one synthesis run: an adversarial pass over its
// contradictions and findings. One critic run audits one synthesis run.
export const criticRuns = pgTable("critic_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  libraryId: uuid("library_id")
    .notNull()
    .references(() => libraries.id, { onDelete: "cascade" }),
  synthesisRunId: uuid("synthesis_run_id")
    .notNull()
    .references(() => synthesisRuns.id, { onDelete: "cascade" }),
  model: text("model"),
  status: text("status").notNull().default("running"), // running | completed | failed
  notes: text("notes"),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

// Verdict on one "contradicts" claim relation: is the conflict real or an
// artifact? Provenance via claim_relation_id.
export const contradictionVerdicts = pgTable("contradiction_verdicts", {
  id: uuid("id").primaryKey().defaultRandom(),
  criticRunId: uuid("critic_run_id")
    .notNull()
    .references(() => criticRuns.id, { onDelete: "cascade" }),
  claimRelationId: uuid("claim_relation_id")
    .notNull()
    .references(() => claimRelations.id, { onDelete: "cascade" }),
  verdict: text("verdict").notNull(), // genuine | definitional | scope_dependent | overstated
  rationale: text("rationale"),
  confidence: text("confidence"), // low | medium | high
  severity: text("severity"), // high | medium | low; null for a clean "genuine"
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Verdict on one finding: is its strength label justified, and does it follow
// from its supporting passages? Provenance via finding_id.
export const findingVerdicts = pgTable("finding_verdicts", {
  id: uuid("id").primaryKey().defaultRandom(),
  criticRunId: uuid("critic_run_id")
    .notNull()
    .references(() => criticRuns.id, { onDelete: "cascade" }),
  findingId: uuid("finding_id")
    .notNull()
    .references(() => findings.id, { onDelete: "cascade" }),
  labelVerdict: text("label_verdict").notNull(), // justified | inflated | manufactured
  groundingVerdict: text("grounding_verdict").notNull(), // grounded | partially_grounded | overreach
  independenceNote: text("independence_note"),
  rationale: text("rationale"),
  confidence: text("confidence"), // low | medium | high
  severity: text("severity"), // high | medium | low; null for a clean pass
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// The Critic's direction-setting abstract for a run: a grounded research
// direction bound to the library hypothesis and steered by conference themes,
// built only on audited-sound findings. One per critic run.
export const criticAbstracts = pgTable("critic_abstracts", {
  id: uuid("id").primaryKey().defaultRandom(),
  criticRunId: uuid("critic_run_id")
    .notNull()
    .references(() => criticRuns.id, { onDelete: "cascade" }),
  title: text("title"),
  abstractText: text("abstract_text"),
  claimToTest: text("claim_to_test"),
  direction: text("direction"),
  groundedOn: text("grounded_on").array().default(sql`'{}'::text[]`), // finding/relation ids
  conferencesConsidered: text("conferences_considered")
    .array()
    .default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type CriticRun = typeof criticRuns.$inferSelect;
export type NewCriticRun = typeof criticRuns.$inferInsert;
export type LibraryConference = typeof libraryConferences.$inferSelect;
export type NewLibraryConference = typeof libraryConferences.$inferInsert;
export type CriticAbstract = typeof criticAbstracts.$inferSelect;
export type NewCriticAbstract = typeof criticAbstracts.$inferInsert;
export type ContradictionVerdict = typeof contradictionVerdicts.$inferSelect;
export type NewContradictionVerdict =
  typeof contradictionVerdicts.$inferInsert;
export type FindingVerdict = typeof findingVerdicts.$inferSelect;
export type NewFindingVerdict = typeof findingVerdicts.$inferInsert;

// Structured quantitative results pulled from a paper's tables/inline text, one
// row per reported number, so the same metric on the same dataset/task can be
// pooled across papers. (dataset_norm, metric_norm, task) is the join key for
// meta-analysis, hence the index.
export const paperMetrics = pgTable(
  "paper_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paperId: uuid("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    methodName: text("method_name"), // the model/approach the number describes
    isSelf: boolean("is_self"), // true = the paper's own proposed method
    task: text("task"),
    datasetRaw: text("dataset_raw"),
    datasetNorm: text("dataset_norm"),
    metricRaw: text("metric_raw"),
    metricNorm: text("metric_norm"),
    // Additive canonical fields for pooling. Derived from *_norm/task via an
    // auditable alias map (see scribe/metric-aliases.ts); merges only genuine
    // equivalents. Raw + norm above are left untouched so every merge is
    // reversible and auditable.
    datasetCanon: text("dataset_canon"),
    metricCanon: text("metric_canon"),
    taskCanon: text("task_canon"),
    value: numeric("value"),
    unit: text("unit"),
    dispersion: text("dispersion"), // std dev / CI / +- as reported, else null
    sampleSize: text("sample_size"), // n / #views / #runs as reported, else null
    conditions: text("conditions"), // qualifying conditions, else null
    sourceKind: text("source_kind"), // table | inline_text
    sourceExcerpt: text("source_excerpt"), // the row/sentence the number came from
    confidence: text("confidence"), // low | medium | high
    extractionVersion: text("extraction_version"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("paper_metrics_joinkey_idx").on(
      table.datasetNorm,
      table.metricNorm,
      table.task,
    ),
    index("paper_metrics_canonkey_idx").on(
      table.datasetCanon,
      table.metricCanon,
      table.taskCanon,
    ),
  ],
);

export type PaperMetric = typeof paperMetrics.$inferSelect;
export type NewPaperMetric = typeof paperMetrics.$inferInsert;

// ---------------------------------------------------------------------------
// Lab-level cross-domain synthesis: reads across MULTIPLE libraries (projects)
// and records what genuinely recurs across domains, grounded in concrete
// evidence. A run is a snapshot over a chosen set of libraries. Distinct from
// the per-library Scribe synthesis and Critic audit, which never see across
// projects. This layer ASSERTS grounded method/claim recurrences and RECORDS
// concept-level rhymes as candidates for the cross-domain Critic (later) to test.
// ---------------------------------------------------------------------------

export const crossDomainRuns = pgTable("cross_domain_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The library ids this run analyzed (the eligible, non-general, synthesized set).
  scope: uuid("scope").array().notNull().default(sql`'{}'::uuid[]`),
  model: text("model"),
  status: text("status").notNull().default("running"), // running | completed | failed
  notes: text("notes"),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

// One cross-domain recurrence. level is the grounding it rests on:
//   method  = the same algorithm/technique appears in multiple libraries.
//   claim   = the same kind of audited finding recurs across libraries.
//   concept = an emergent rhyme that POINTS TO underlying method/claim links;
//             never asserted on its own, always is_candidate.
// is_candidate = true means "needs cross-domain Critic pressure-testing", not
// established. library_ids names the libraries it spans (>=2).
export const crossDomainLinks = pgTable(
  "cross_domain_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    crossDomainRunId: uuid("cross_domain_run_id")
      .notNull()
      .references(() => crossDomainRuns.id, { onDelete: "cascade" }),
    level: text("level").notNull(), // method | claim | concept
    summary: text("summary").notNull(), // the recurrence stated plainly
    libraryIds: uuid("library_ids").array().notNull().default(sql`'{}'::uuid[]`),
    confidence: text("confidence"), // low | medium | high
    isCandidate: boolean("is_candidate").notNull().default(false),
    // How this link entered the run: "synthesis" = the cross-domain synthesizer
    // proposed it; "discovery" = the cross-domain Critic's discovery pass found
    // it; "web_discovery" = the research web's ABC/bridge crossover proposals
    // (all candidates). All live under the same cross_domain_run_id and are
    // audited by the same cross-domain Critic.
    source: text("source").notNull().default("synthesis"), // synthesis | discovery | web_discovery
    rationale: text("rationale"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("cross_domain_links_run_level_idx").on(
      table.crossDomainRunId,
      table.level,
    ),
  ],
);

// Concrete provenance for one link: the specific method/finding/claim in one
// specific library it rests on. Every link has >=2 of these (>=1 per library it
// spans); a link whose evidence cannot be validated is not stored.
export const crossDomainLinkEvidence = pgTable("cross_domain_link_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  linkId: uuid("link_id")
    .notNull()
    .references(() => crossDomainLinks.id, { onDelete: "cascade" }),
  libraryId: uuid("library_id")
    .notNull()
    .references(() => libraries.id, { onDelete: "cascade" }),
  evidenceKind: text("evidence_kind").notNull(), // method | finding | claim
  evidenceRef: text("evidence_ref").notNull(), // method_name or finding_id/claim_id
  excerpt: text("excerpt"), // the concrete thing + its context (e.g. finding text + Critic verdict)
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type CrossDomainRun = typeof crossDomainRuns.$inferSelect;
export type NewCrossDomainRun = typeof crossDomainRuns.$inferInsert;
export type CrossDomainLink = typeof crossDomainLinks.$inferSelect;
export type NewCrossDomainLink = typeof crossDomainLinks.$inferInsert;
export type CrossDomainLinkEvidence =
  typeof crossDomainLinkEvidence.$inferSelect;
export type NewCrossDomainLinkEvidence =
  typeof crossDomainLinkEvidence.$inferInsert;

// The cross-domain Critic: an adversarial audit of ONE cross-domain run. It
// validates the run's links (skeptical pass) and discovers missed connections
// (conservative pass). One critic run audits one cross-domain run.
export const crossDomainCriticRuns = pgTable("cross_domain_critic_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  crossDomainRunId: uuid("cross_domain_run_id")
    .notNull()
    .references(() => crossDomainRuns.id, { onDelete: "cascade" }),
  model: text("model"),
  status: text("status").notNull().default("running"), // running | completed | failed
  notes: text("notes"),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

// One skeptical verdict on one cross-domain link. verdict:
//   confirmed = a grounded link that survived the attack.
//   promoted  = a candidate whose evidence holds; it earns grounded status.
//   demoted   = a grounded link whose evidence does not withstand attack;
//               it becomes a candidate.
//   rejected  = superficial / vocabulary coincidence; not a real recurrence.
// The verdict is an audit record; it does not mutate the link row (provenance).
export const linkVerdicts = pgTable(
  "link_verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    criticRunId: uuid("critic_run_id")
      .notNull()
      .references(() => crossDomainCriticRuns.id, { onDelete: "cascade" }),
    linkId: uuid("link_id")
      .notNull()
      .references(() => crossDomainLinks.id, { onDelete: "cascade" }),
    verdict: text("verdict").notNull(), // confirmed | promoted | demoted | rejected
    rationale: text("rationale"), // the skeptic's reasoning, grounded in the evidence
    confidence: text("confidence"), // low | medium | high
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("link_verdicts_run_idx").on(table.criticRunId),
  ],
);

export type CrossDomainCriticRun = typeof crossDomainCriticRuns.$inferSelect;
export type NewCrossDomainCriticRun = typeof crossDomainCriticRuns.$inferInsert;
export type LinkVerdict = typeof linkVerdicts.$inferSelect;
export type NewLinkVerdict = typeof linkVerdicts.$inferInsert;

// ---------------------------------------------------------------------------
// Experimentalist: takes a CLAIM + an EVIDENCE SCOPE (one or more libraries)
// and produces (A) a deterministic quantitative meta-analysis of what the
// literature already reports (pooling math in TypeScript over paper_metrics, NO
// LLM number), interpreted by an LLM, and (B) a verifiable, execution-ready
// experiment spec. Execution itself is a separate future layer, not built here.
// A run is an immutable snapshot. Library-agnostic: three input modes resolve to
// the same claim+scope contract.
// ---------------------------------------------------------------------------

export const experimentalistRuns = pgTable("experimentalist_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  inputKind: text("input_kind").notNull(), // abstract | cross_domain_link | library
  inputRef: text("input_ref").notNull(), // the abstract id / link id / library id
  claim: text("claim").notNull(), // the claim under test, as resolved/derived
  scopeLibraryIds: uuid("scope_library_ids").array().notNull().default(sql`'{}'::uuid[]`),
  model: text("model"),
  status: text("status").notNull().default("running"), // running | completed | failed
  // The LLM's interpretation of the COMPUTED tables, kept clearly separate from
  // the numbers: { verdict, text, caveats[], unknowns[], keysCited[], findingsCited[] }.
  interpretation: jsonb("interpretation"),
  notes: text("notes"),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

// One deterministically pooled result: a (dataset, metric, task, conditions)
// slice under one pooling kind. computed holds the full computed table
// (contributing rows, ranks/win-rates/medians, conflict flags, dedup notes).
// NO LLM writes any number here.
export const metaAnalyses = pgTable(
  "meta_analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => experimentalistRuns.id, { onDelete: "cascade" }),
    keyDataset: text("key_dataset"), // dataset_canon
    keyMetric: text("key_metric"), // metric_canon
    keyTask: text("key_task"), // task_canon
    keyConditions: text("key_conditions"), // the protocol/flavor slice
    poolKind: text("pool_kind").notNull(), // vote_count | rank | best_median | variance_weighted_subset
    computed: jsonb("computed").notNull(),
    nMethods: integer("n_methods"),
    nPapers: integer("n_papers"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("meta_analyses_run_idx").on(table.runId)],
);

// The honest-degradation path: for a scope library with no metric rows, the
// qualitative evidence (audited-sound findings relevant to the claim) that
// stands in for pooling. Never a fabricated number.
export const qualitativeEvidence = pgTable(
  "qualitative_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => experimentalistRuns.id, { onDelete: "cascade" }),
    libraryId: uuid("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    findingRef: uuid("finding_ref"), // the finding id, for provenance
    excerpt: text("excerpt"),
    relevanceNote: text("relevance_note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("qualitative_evidence_run_idx").on(table.runId)],
);

// The execution-ready experiment spec (one per run). The LLM designs it grounded
// in the meta-analysis; nothing is executed. Structured fields are jsonb.
export const experimentSpecs = pgTable("experiment_specs", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => experimentalistRuns.id, { onDelete: "cascade" }),
  title: text("title"),
  objective: text("objective"), // the claim restated as the thing the experiment decides
  design: jsonb("design"), // { arms[], held_fixed[], procedure }
  metrics: jsonb("metrics"), // what is measured, on what datasets, why
  confirmCriteria: text("confirm_criteria"), // explicit outcome that CONFIRMS the claim
  refuteCriteria: text("refute_criteria"), // explicit outcome that REFUTES it
  environment: jsonb("environment"), // { dependencies, datasets, hardware, scale_notes }
  verificationHarness: text("verification_harness"), // how a result would be checked
  humanDecisions: jsonb("human_decisions"), // choices deliberately left to a human
  limitations: text("limitations"), // what this design cannot settle
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ExperimentalistRun = typeof experimentalistRuns.$inferSelect;
export type NewExperimentalistRun = typeof experimentalistRuns.$inferInsert;
export type MetaAnalysis = typeof metaAnalyses.$inferSelect;
export type NewMetaAnalysis = typeof metaAnalyses.$inferInsert;
export type QualitativeEvidence = typeof qualitativeEvidence.$inferSelect;
export type NewQualitativeEvidence = typeof qualitativeEvidence.$inferInsert;
export type ExperimentSpec = typeof experimentSpecs.$inferSelect;
export type NewExperimentSpec = typeof experimentSpecs.$inferInsert;

// ---------------------------------------------------------------------------
// Writer: documents one research thread end to end as a structured research
// write-up. It is a DOCUMENTARIAN, not an author: every substantive statement
// traces to something that already exists (an audited-sound finding, a computed
// meta_analyses row, the stored interpretation/spec, a Critic verdict, a
// cross-domain link + verdict). No new numbers, findings, or claims. A run is an
// immutable snapshot. A future execution-results mode is additive (the results
// section is currently an honest placeholder).
// ---------------------------------------------------------------------------

export const writerRuns = pgTable("writer_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  experimentalistRunId: uuid("experimentalist_run_id")
    .notNull()
    .references(() => experimentalistRuns.id, { onDelete: "cascade" }),
  model: text("model"),
  status: text("status").notNull().default("running"), // running | completed | failed
  notes: text("notes"),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

// The generated research document (one per writer run). sections is the ordered
// list of fixed sections, each { key, heading, body, kind }. provenance maps each
// section key to the finding / meta_analyses / spec / verdict / link ids it rests
// on, so every section is auditable back to real upstream data.
export const researchDocuments = pgTable("research_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  writerRunId: uuid("writer_run_id")
    .notNull()
    .references(() => writerRuns.id, { onDelete: "cascade" }),
  title: text("title"),
  sections: jsonb("sections").notNull(), // [{ key, heading, body, kind }]
  provenance: jsonb("provenance"), // { [sectionKey]: string[] } of resolved ref ids
  conferencesConsidered: text("conferences_considered")
    .array()
    .default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type WriterRun = typeof writerRuns.$inferSelect;
export type NewWriterRun = typeof writerRuns.$inferInsert;
export type ResearchDocument = typeof researchDocuments.$inferSelect;
export type NewResearchDocument = typeof researchDocuments.$inferInsert;

// ---------------------------------------------------------------------------
// Research web: a corpus-wide knowledge graph that is the lab's PRIMARY
// substrate (libraries become optional lenses on top). Nodes are papers,
// claims, methods, datasets, and canonicalized concepts; edges are semantic
// (paper-paper kNN), typed claim relations, and mention/use/report/cite links.
// On top of the web: emergent domain discovery (seeded Louvain community
// detection), bridge analytics (betweenness), and literature-based discovery
// (Swanson ABC + structure-mapped analogy). Discovery outputs feed the EXISTING
// validated cross-domain pipeline as candidates. Every build is an immutable
// snapshot; a rebuild is a new run.
// ---------------------------------------------------------------------------

export const webBuildRuns = pgTable("web_build_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  // knn_k, semantic_floor, louvain_resolution, seed, concept_merge_threshold,
  // and the projection edge-weight vector.
  params: jsonb("params").notNull(),
  status: text("status").notNull().default("running"), // running | completed | failed
  // node/edge/community counts, ARI vs libraries, orphan report.
  stats: jsonb("stats"),
  notes: text("notes"),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

// The communities are inserted before nodes in the same run so a node can carry
// a real FK to its community. community_index is the Louvain integer label.
export const webCommunities = pgTable(
  "web_communities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => webBuildRuns.id, { onDelete: "cascade" }),
    communityIndex: integer("community_index").notNull(),
    label: text("label"), // LLM-assigned from top concepts/methods (labeling, not analysis)
    size: integer("size"),
    topConcepts: jsonb("top_concepts"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("web_communities_run_idx").on(table.runId)],
);

export const webNodes = pgTable(
  "web_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => webBuildRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // paper | claim | method | concept | dataset
    refTable: text("ref_table"), // provenance to the source row
    refId: uuid("ref_id"), // null for merged concepts (see mergedFrom)
    mergedFrom: jsonb("merged_from"), // for concepts: the terms merged into this node
    label: text("label"),
    canonicalLabel: text("canonical_label"),
    degree: integer("degree"), // filled at build time (projection or full-graph degree)
    communityId: uuid("community_id").references(() => webCommunities.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("web_nodes_run_kind_idx").on(table.runId, table.kind)],
);

export const webEdges = pgTable(
  "web_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => webBuildRuns.id, { onDelete: "cascade" }),
    srcNodeId: uuid("src_node_id")
      .notNull()
      .references(() => webNodes.id, { onDelete: "cascade" }),
    dstNodeId: uuid("dst_node_id")
      .notNull()
      .references(() => webNodes.id, { onDelete: "cascade" }),
    // semantic | supports | contradicts | extends | mentions_concept |
    // uses_method | reports_dataset | cites
    kind: text("kind").notNull(),
    weight: real("weight").notNull(),
    provenance: jsonb("provenance"), // claim_relation id, similarity score, key_terms source, etc.
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("web_edges_run_kind_idx").on(table.runId, table.kind)],
);

// Deterministic bridge analytics + ABC (Swanson) discovery candidates.
export const webBridges = pgTable(
  "web_bridges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => webBuildRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // edge_bridge | node_bridge | abc
    score: real("score").notNull(),
    // abc: {a_node, b_evidence, c_node, a_community, c_community, path_evidence}
    // bridges: the edge/node + the communities it connects + betweenness.
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("web_bridges_run_kind_score_idx").on(table.runId, table.kind, table.score)],
);

export type WebBuildRun = typeof webBuildRuns.$inferSelect;
export type NewWebBuildRun = typeof webBuildRuns.$inferInsert;
export type WebCommunity = typeof webCommunities.$inferSelect;
export type NewWebCommunity = typeof webCommunities.$inferInsert;
export type WebNode = typeof webNodes.$inferSelect;
export type NewWebNode = typeof webNodes.$inferInsert;
export type WebEdge = typeof webEdges.$inferSelect;
export type NewWebEdge = typeof webEdges.$inferInsert;
export type WebBridge = typeof webBridges.$inferSelect;
export type NewWebBridge = typeof webBridges.$inferInsert;
