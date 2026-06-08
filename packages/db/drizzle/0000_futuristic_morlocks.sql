CREATE TABLE "annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paper_id" uuid,
	"claim_id" uuid,
	"text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"affiliation" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"citing_paper_id" uuid NOT NULL,
	"cited_paper_id" uuid,
	"cited_title" text NOT NULL,
	"cited_arxiv_id" text,
	"context" text
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paper_id" uuid NOT NULL,
	"text" text NOT NULL,
	"source_passage" text,
	"confidence" text,
	"extracted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paper_id" uuid NOT NULL,
	"extraction_version" text NOT NULL,
	"problem" text,
	"prior_work" text,
	"method" text,
	"results" text,
	"limitations" text,
	"key_terms" text[] DEFAULT '{}'::text[],
	"datasets_used" text[] DEFAULT '{}'::text[],
	"extracted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_authors" (
	"paper_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "paper_authors_paper_id_author_id_pk" PRIMARY KEY("paper_id","author_id")
);
--> statement-breakpoint
CREATE TABLE "papers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arxiv_id" text,
	"title" text NOT NULL,
	"authors" text[] DEFAULT '{}'::text[] NOT NULL,
	"abstract" text,
	"published_at" timestamp,
	"url" text NOT NULL,
	"pdf_url" text,
	"raw_text" text,
	"ingested_at" timestamp DEFAULT now() NOT NULL,
	"last_processed_at" timestamp,
	CONSTRAINT "papers_arxiv_id_unique" UNIQUE("arxiv_id")
);
--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_citing_paper_id_papers_id_fk" FOREIGN KEY ("citing_paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_cited_paper_id_papers_id_fk" FOREIGN KEY ("cited_paper_id") REFERENCES "public"."papers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_authors" ADD CONSTRAINT "paper_authors_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_authors" ADD CONSTRAINT "paper_authors_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE cascade ON UPDATE no action;