CREATE TABLE "conceptnet_cache" (
	"term" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "web_nodes" ADD COLUMN "coord_x" real;--> statement-breakpoint
ALTER TABLE "web_nodes" ADD COLUMN "coord_y" real;--> statement-breakpoint
ALTER TABLE "web_nodes" ADD COLUMN "coord_z" real;