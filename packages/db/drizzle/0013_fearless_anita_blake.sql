CREATE TABLE "cross_domain_critic_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cross_domain_run_id" uuid NOT NULL,
	"model" text,
	"status" text DEFAULT 'running' NOT NULL,
	"notes" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "link_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"critic_run_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"rationale" text,
	"confidence" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cross_domain_links" ADD COLUMN "source" text DEFAULT 'synthesis' NOT NULL;--> statement-breakpoint
ALTER TABLE "cross_domain_critic_runs" ADD CONSTRAINT "cross_domain_critic_runs_cross_domain_run_id_cross_domain_runs_id_fk" FOREIGN KEY ("cross_domain_run_id") REFERENCES "public"."cross_domain_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_verdicts" ADD CONSTRAINT "link_verdicts_critic_run_id_cross_domain_critic_runs_id_fk" FOREIGN KEY ("critic_run_id") REFERENCES "public"."cross_domain_critic_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_verdicts" ADD CONSTRAINT "link_verdicts_link_id_cross_domain_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."cross_domain_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "link_verdicts_run_idx" ON "link_verdicts" USING btree ("critic_run_id");