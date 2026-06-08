CREATE TABLE "claim_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_claim_id" uuid NOT NULL,
	"to_claim_id" uuid NOT NULL,
	"relation_type" text NOT NULL,
	"rationale" text,
	"synthesis_run_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_papers" (
	"finding_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"supporting_claim_id" uuid,
	CONSTRAINT "finding_papers_finding_id_paper_id_pk" PRIMARY KEY("finding_id","paper_id")
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement" text NOT NULL,
	"detail" text,
	"synthesis_run_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_themes" (
	"paper_id" uuid NOT NULL,
	"theme_id" uuid NOT NULL,
	"relevance" text,
	CONSTRAINT "paper_themes_paper_id_theme_id_pk" PRIMARY KEY("paper_id","theme_id")
);
--> statement-breakpoint
CREATE TABLE "synthesis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"status" text DEFAULT 'running' NOT NULL,
	"paper_count" integer,
	"model" text,
	"error" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "themes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"synthesis_run_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim_relations" ADD CONSTRAINT "claim_relations_from_claim_id_claims_id_fk" FOREIGN KEY ("from_claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_relations" ADD CONSTRAINT "claim_relations_to_claim_id_claims_id_fk" FOREIGN KEY ("to_claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_relations" ADD CONSTRAINT "claim_relations_synthesis_run_id_synthesis_runs_id_fk" FOREIGN KEY ("synthesis_run_id") REFERENCES "public"."synthesis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_papers" ADD CONSTRAINT "finding_papers_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_papers" ADD CONSTRAINT "finding_papers_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_papers" ADD CONSTRAINT "finding_papers_supporting_claim_id_claims_id_fk" FOREIGN KEY ("supporting_claim_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_synthesis_run_id_synthesis_runs_id_fk" FOREIGN KEY ("synthesis_run_id") REFERENCES "public"."synthesis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_themes" ADD CONSTRAINT "paper_themes_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_themes" ADD CONSTRAINT "paper_themes_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_synthesis_run_id_synthesis_runs_id_fk" FOREIGN KEY ("synthesis_run_id") REFERENCES "public"."synthesis_runs"("id") ON DELETE cascade ON UPDATE no action;