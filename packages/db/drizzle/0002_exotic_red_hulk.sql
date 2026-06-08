CREATE TABLE "libraries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_libraries" (
	"paper_id" uuid NOT NULL,
	"library_id" uuid NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "paper_libraries_paper_id_library_id_pk" PRIMARY KEY("paper_id","library_id")
);
--> statement-breakpoint
ALTER TABLE "synthesis_runs" ADD COLUMN "library_id" uuid;--> statement-breakpoint
ALTER TABLE "paper_libraries" ADD CONSTRAINT "paper_libraries_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_libraries" ADD CONSTRAINT "paper_libraries_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_runs" ADD CONSTRAINT "synthesis_runs_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;