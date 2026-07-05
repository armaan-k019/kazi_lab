CREATE TABLE "experiment_specs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"title" text,
	"objective" text,
	"design" jsonb,
	"metrics" jsonb,
	"confirm_criteria" text,
	"refute_criteria" text,
	"environment" jsonb,
	"verification_harness" text,
	"human_decisions" jsonb,
	"limitations" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experimentalist_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"input_kind" text NOT NULL,
	"input_ref" text NOT NULL,
	"claim" text NOT NULL,
	"scope_library_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"model" text,
	"status" text DEFAULT 'running' NOT NULL,
	"interpretation" jsonb,
	"notes" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "meta_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"key_dataset" text,
	"key_metric" text,
	"key_task" text,
	"key_conditions" text,
	"pool_kind" text NOT NULL,
	"computed" jsonb NOT NULL,
	"n_methods" integer,
	"n_papers" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qualitative_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"library_id" uuid NOT NULL,
	"finding_ref" uuid,
	"excerpt" text,
	"relevance_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "experiment_specs" ADD CONSTRAINT "experiment_specs_run_id_experimentalist_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."experimentalist_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_analyses" ADD CONSTRAINT "meta_analyses_run_id_experimentalist_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."experimentalist_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualitative_evidence" ADD CONSTRAINT "qualitative_evidence_run_id_experimentalist_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."experimentalist_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualitative_evidence" ADD CONSTRAINT "qualitative_evidence_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meta_analyses_run_idx" ON "meta_analyses" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "qualitative_evidence_run_idx" ON "qualitative_evidence" USING btree ("run_id");