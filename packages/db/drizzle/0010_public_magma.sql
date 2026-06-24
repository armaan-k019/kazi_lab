CREATE TABLE "paper_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paper_id" uuid NOT NULL,
	"method_name" text,
	"is_self" boolean,
	"task" text,
	"dataset_raw" text,
	"dataset_norm" text,
	"metric_raw" text,
	"metric_norm" text,
	"value" numeric,
	"unit" text,
	"dispersion" text,
	"sample_size" text,
	"conditions" text,
	"source_kind" text,
	"source_excerpt" text,
	"confidence" text,
	"extraction_version" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paper_metrics" ADD CONSTRAINT "paper_metrics_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paper_metrics_joinkey_idx" ON "paper_metrics" USING btree ("dataset_norm","metric_norm","task");