CREATE TABLE "open_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"synthesis_run_id" uuid NOT NULL,
	"library_id" uuid NOT NULL,
	"question" text NOT NULL,
	"rationale" text,
	"related_paper_ids" uuid[] DEFAULT '{}'::uuid[],
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "consensus" text;--> statement-breakpoint
ALTER TABLE "open_questions" ADD CONSTRAINT "open_questions_synthesis_run_id_synthesis_runs_id_fk" FOREIGN KEY ("synthesis_run_id") REFERENCES "public"."synthesis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_questions" ADD CONSTRAINT "open_questions_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;