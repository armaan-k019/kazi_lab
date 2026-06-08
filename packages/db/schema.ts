import { sql } from "drizzle-orm";
import {
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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
  createdAt: timestamp("created_at").notNull().defaultNow(),
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
