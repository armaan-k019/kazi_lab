CREATE TABLE "paper_external" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paper_id" uuid NOT NULL,
	"source" text NOT NULL,
	"openalex_id" text,
	"doi" text,
	"cited_by_count" integer,
	"venue" text,
	"authoritative_title" text,
	"authoritative_year" integer,
	"match_status" text NOT NULL,
	"match_score" numeric,
	"author_openalex_ids" text[] DEFAULT '{}'::text[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paper_external" ADD CONSTRAINT "paper_external_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paper_external_paper_source_uq" ON "paper_external" USING btree ("paper_id","source");