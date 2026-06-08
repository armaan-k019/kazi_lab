import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Load the repo-root .env.local before anything reads DATABASE_URL /
// OPENALEX_MAILTO. Existing process.env values win.
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resolve all papers lacking a paper_external row against OpenAlex. Idempotent:
// only papers without an external record are processed. Spaced politely.
async function main(): Promise<void> {
  const { eq } = await import("drizzle-orm");
  const { db, papers, paperExternal } = await import("@kazi-lab/db");
  const { enrichPaperExternal } = await import("./enrich-store");

  const allPapers = await db
    .select({
      id: papers.id,
      title: papers.title,
      authors: papers.authors,
      publishedAt: papers.publishedAt,
      arxivId: papers.arxivId,
    })
    .from(papers);
  const existing = await db
    .select({ paperId: paperExternal.paperId })
    .from(paperExternal)
    .where(eq(paperExternal.source, "openalex"));
  const done = new Set(existing.map((e) => e.paperId));

  const todo = allPapers.filter((p) => !done.has(p.id));
  let matched = 0;
  let ambiguous = 0;
  let unmatched = 0;
  let improved = 0;

  for (let i = 0; i < todo.length; i++) {
    const p = todo[i];
    if (i > 0) await sleep(800); // be polite to OpenAlex
    try {
      const r = await enrichPaperExternal({
        paperId: p.id,
        paper: {
          title: p.title,
          authors: p.authors,
          publishedAt: p.publishedAt,
          arxivId: p.arxivId,
        },
      });
      if (r.matchStatus === "matched") matched++;
      else if (r.matchStatus === "ambiguous") ambiguous++;
      else unmatched++;
      if (r.improvedMetadata) improved++;
      console.log(
        `  ${r.matchStatus}${r.improvedMetadata ? " (improved)" : ""}: ${p.title.slice(0, 50)}`,
      );
    } catch (e) {
      unmatched++;
      console.error(`  error: ${p.title.slice(0, 50)} -> ${(e as Error).message}`);
    }
  }

  console.log("");
  console.log(`total papers:   ${allPapers.length}`);
  console.log(`processed:      ${todo.length} (already done: ${done.size})`);
  console.log(`matched:        ${matched}`);
  console.log(`ambiguous:      ${ambiguous}`);
  console.log(`unmatched:      ${unmatched}`);
  console.log(`metadata improved: ${improved}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Enrich backfill failed:");
    console.error(error);
    process.exit(1);
  });
