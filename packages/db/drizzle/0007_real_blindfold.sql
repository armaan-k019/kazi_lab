CREATE TABLE "contradiction_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"critic_run_id" uuid NOT NULL,
	"claim_relation_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"rationale" text,
	"confidence" text,
	"severity" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "critic_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" uuid NOT NULL,
	"synthesis_run_id" uuid NOT NULL,
	"model" text,
	"status" text DEFAULT 'running' NOT NULL,
	"notes" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "finding_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"critic_run_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"label_verdict" text NOT NULL,
	"grounding_verdict" text NOT NULL,
	"independence_note" text,
	"rationale" text,
	"confidence" text,
	"severity" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contradiction_verdicts" ADD CONSTRAINT "contradiction_verdicts_critic_run_id_critic_runs_id_fk" FOREIGN KEY ("critic_run_id") REFERENCES "public"."critic_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contradiction_verdicts" ADD CONSTRAINT "contradiction_verdicts_claim_relation_id_claim_relations_id_fk" FOREIGN KEY ("claim_relation_id") REFERENCES "public"."claim_relations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "critic_runs" ADD CONSTRAINT "critic_runs_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "critic_runs" ADD CONSTRAINT "critic_runs_synthesis_run_id_synthesis_runs_id_fk" FOREIGN KEY ("synthesis_run_id") REFERENCES "public"."synthesis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_verdicts" ADD CONSTRAINT "finding_verdicts_critic_run_id_critic_runs_id_fk" FOREIGN KEY ("critic_run_id") REFERENCES "public"."critic_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_verdicts" ADD CONSTRAINT "finding_verdicts_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;