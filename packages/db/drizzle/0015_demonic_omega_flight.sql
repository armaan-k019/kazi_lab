CREATE TABLE "research_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"writer_run_id" uuid NOT NULL,
	"title" text,
	"sections" jsonb NOT NULL,
	"provenance" jsonb,
	"conferences_considered" text[] DEFAULT '{}'::text[],
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "writer_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experimentalist_run_id" uuid NOT NULL,
	"model" text,
	"status" text DEFAULT 'running' NOT NULL,
	"notes" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "research_documents" ADD CONSTRAINT "research_documents_writer_run_id_writer_runs_id_fk" FOREIGN KEY ("writer_run_id") REFERENCES "public"."writer_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writer_runs" ADD CONSTRAINT "writer_runs_experimentalist_run_id_experimentalist_runs_id_fk" FOREIGN KEY ("experimentalist_run_id") REFERENCES "public"."experimentalist_runs"("id") ON DELETE cascade ON UPDATE no action;