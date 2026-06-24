ALTER TABLE "paper_metrics" ADD COLUMN "dataset_canon" text;--> statement-breakpoint
ALTER TABLE "paper_metrics" ADD COLUMN "metric_canon" text;--> statement-breakpoint
ALTER TABLE "paper_metrics" ADD COLUMN "task_canon" text;--> statement-breakpoint
CREATE INDEX "paper_metrics_canonkey_idx" ON "paper_metrics" USING btree ("dataset_canon","metric_canon","task_canon");