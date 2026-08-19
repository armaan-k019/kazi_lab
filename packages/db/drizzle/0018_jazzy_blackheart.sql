CREATE TABLE "scheduler_diagnostics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"diagnostic_kind" text NOT NULL,
	"affected_library_id" uuid,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"detection_pass_start" timestamp DEFAULT now() NOT NULL,
	"detection_pass_end" timestamp,
	"status" text DEFAULT 'awaiting_approval' NOT NULL,
	"tasks_queued" integer DEFAULT 0 NOT NULL,
	"tasks_approved" integer DEFAULT 0 NOT NULL,
	"tasks_executed" integer DEFAULT 0 NOT NULL,
	"tasks_failed" integer DEFAULT 0 NOT NULL,
	"stats" jsonb,
	"notes" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"scope" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"priority" integer NOT NULL,
	"cost_estimate_usd" real NOT NULL,
	"cost_estimate_tokens" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"approval_required" boolean DEFAULT true NOT NULL,
	"human_approval_at" timestamp,
	"human_approval_by" text,
	"command_result" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "scheduler_diagnostics" ADD CONSTRAINT "scheduler_diagnostics_run_id_scheduler_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scheduler_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler_diagnostics" ADD CONSTRAINT "scheduler_diagnostics_affected_library_id_libraries_id_fk" FOREIGN KEY ("affected_library_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler_tasks" ADD CONSTRAINT "scheduler_tasks_run_id_scheduler_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scheduler_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduler_tasks_run_status_idx" ON "scheduler_tasks" USING btree ("run_id","status");