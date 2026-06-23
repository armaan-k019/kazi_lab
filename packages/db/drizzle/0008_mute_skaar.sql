CREATE TABLE "critic_abstracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"critic_run_id" uuid NOT NULL,
	"title" text,
	"abstract_text" text,
	"claim_to_test" text,
	"direction" text,
	"grounded_on" text[] DEFAULT '{}'::text[],
	"conferences_considered" text[] DEFAULT '{}'::text[],
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_conferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_url" text,
	"source_kind" text DEFAULT 'none' NOT NULL,
	"raw_source_text" text,
	"themes" text[] DEFAULT '{}'::text[],
	"key_dates" text[] DEFAULT '{}'::text[],
	"scope_summary" text,
	"synth_status" text DEFAULT 'none' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "research_focus" text;--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "hypothesis" text;--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "user_notes" text;--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "target_venue_type" text;--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "critic_abstracts" ADD CONSTRAINT "critic_abstracts_critic_run_id_critic_runs_id_fk" FOREIGN KEY ("critic_run_id") REFERENCES "public"."critic_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_conferences" ADD CONSTRAINT "library_conferences_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;