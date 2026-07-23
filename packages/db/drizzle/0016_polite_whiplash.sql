CREATE TABLE "web_bridges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"score" real NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_build_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"params" jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"stats" jsonb,
	"notes" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "web_communities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"community_index" integer NOT NULL,
	"label" text,
	"size" integer,
	"top_concepts" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"src_node_id" uuid NOT NULL,
	"dst_node_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"weight" real NOT NULL,
	"provenance" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_table" text,
	"ref_id" uuid,
	"merged_from" jsonb,
	"label" text,
	"canonical_label" text,
	"degree" integer,
	"community_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "web_bridges" ADD CONSTRAINT "web_bridges_run_id_web_build_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."web_build_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_communities" ADD CONSTRAINT "web_communities_run_id_web_build_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."web_build_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_edges" ADD CONSTRAINT "web_edges_run_id_web_build_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."web_build_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_edges" ADD CONSTRAINT "web_edges_src_node_id_web_nodes_id_fk" FOREIGN KEY ("src_node_id") REFERENCES "public"."web_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_edges" ADD CONSTRAINT "web_edges_dst_node_id_web_nodes_id_fk" FOREIGN KEY ("dst_node_id") REFERENCES "public"."web_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_nodes" ADD CONSTRAINT "web_nodes_run_id_web_build_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."web_build_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_nodes" ADD CONSTRAINT "web_nodes_community_id_web_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."web_communities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_bridges_run_kind_score_idx" ON "web_bridges" USING btree ("run_id","kind","score");--> statement-breakpoint
CREATE INDEX "web_communities_run_idx" ON "web_communities" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "web_edges_run_kind_idx" ON "web_edges" USING btree ("run_id","kind");--> statement-breakpoint
CREATE INDEX "web_nodes_run_kind_idx" ON "web_nodes" USING btree ("run_id","kind");