CREATE TABLE "paper_narrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"synthesis_run_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"narration" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paper_narrations" ADD CONSTRAINT "paper_narrations_synthesis_run_id_synthesis_runs_id_fk" FOREIGN KEY ("synthesis_run_id") REFERENCES "public"."synthesis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_narrations" ADD CONSTRAINT "paper_narrations_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;