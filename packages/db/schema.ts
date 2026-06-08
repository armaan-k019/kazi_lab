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
