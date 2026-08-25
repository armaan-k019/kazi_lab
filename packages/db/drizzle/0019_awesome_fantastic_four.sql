CREATE TABLE "expansion_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"s2_paper_id" text NOT NULL,
	"title" text NOT NULL,
	"arxiv_id" text,
	"doi" text,
	"fields_of_study" jsonb,
	"citation_count" integer,
	"linked_paper_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"influential_from_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"corpus_links" integer DEFAULT 0 NOT NULL,
	"influential_links" integer DEFAULT 0 NOT NULL,
	"field_fit" real,
	"score" real,
	"eligible" boolean,
	"ineligible_reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"source_url" text,
	"assigned_library_id" uuid,
	"paper_id" uuid,
	"selected_wave" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expansion_frontier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"s2_paper_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"fields" jsonb,
	"refs_found" integer,
	"cites_found" integer,
	"joined_wave" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expansion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_new" integer NOT NULL,
	"wave_size" integer NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"current_wave" integer DEFAULT 0 NOT NULL,
	"corpus_size_start" integer,
	"library_counts_start" jsonb,
	"field_distribution" jsonb,
	"params" jsonb,
	"notes" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expansion_candidates" ADD CONSTRAINT "expansion_candidates_run_id_expansion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."expansion_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expansion_candidates" ADD CONSTRAINT "expansion_candidates_assigned_library_id_libraries_id_fk" FOREIGN KEY ("assigned_library_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expansion_candidates" ADD CONSTRAINT "expansion_candidates_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expansion_frontier" ADD CONSTRAINT "expansion_frontier_run_id_expansion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."expansion_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expansion_frontier" ADD CONSTRAINT "expansion_frontier_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expansion_candidates_run_s2_uq" ON "expansion_candidates" USING btree ("run_id","s2_paper_id");--> statement-breakpoint
CREATE INDEX "expansion_candidates_run_status_idx" ON "expansion_candidates" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "expansion_frontier_run_paper_uq" ON "expansion_frontier" USING btree ("run_id","paper_id");--> statement-breakpoint
CREATE INDEX "expansion_frontier_run_status_idx" ON "expansion_frontier" USING btree ("run_id","status");