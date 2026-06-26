CREATE TABLE "cross_domain_link_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"library_id" uuid NOT NULL,
	"evidence_kind" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"excerpt" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cross_domain_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cross_domain_run_id" uuid NOT NULL,
	"level" text NOT NULL,
	"summary" text NOT NULL,
	"library_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"confidence" text,
	"is_candidate" boolean DEFAULT false NOT NULL,
	"rationale" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cross_domain_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"model" text,
	"status" text DEFAULT 'running' NOT NULL,
	"notes" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "cross_domain_link_evidence" ADD CONSTRAINT "cross_domain_link_evidence_link_id_cross_domain_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."cross_domain_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_domain_link_evidence" ADD CONSTRAINT "cross_domain_link_evidence_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_domain_links" ADD CONSTRAINT "cross_domain_links_cross_domain_run_id_cross_domain_runs_id_fk" FOREIGN KEY ("cross_domain_run_id") REFERENCES "public"."cross_domain_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cross_domain_links_run_level_idx" ON "cross_domain_links" USING btree ("cross_domain_run_id","level");