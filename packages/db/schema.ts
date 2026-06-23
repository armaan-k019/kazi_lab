import { sql } from "drizzle-orm";
import {
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
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
