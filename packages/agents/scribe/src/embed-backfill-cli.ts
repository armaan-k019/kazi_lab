import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Load the repo-root .env.local before anything reads VOYAGE_API_KEY or
// DATABASE_URL. Existing process.env values win.
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

// Backfill embeddings for any papers/claims that lack them. Idempotent: only
// missing items are embedded. Safe to re-run.
async function main(): Promise<void> {
  const { eq } = await import("drizzle-orm");
  const { db, papers, claims, extractions, embeddings } = await import(
    "@kazi-lab/db"
  );
  const { embedAndStorePaper, buildPaperSummary } = await import(
    "./embed-store"
  );

  const allPapers = await db.select({ id: papers.id }).from(papers);
  const existing = await db
    .select({ entityType: embeddings.entityType, entityId: embeddings.entityId })
    .from(embeddings);
  const embeddedClaims = new Set(
    existing.filter((e) => e.entityType === "claim").map((e) => e.entityId),
  );
  const embeddedPapers = new Set(
    existing.filter((e) => e.entityType === "paper").map((e) => e.entityId),
  );

  let claimCount = 0;
  let paperCount = 0;
  let papersTouched = 0;

  for (const p of allPapers) {
    const paperClaims = await db
      .select({ id: claims.id, text: claims.text })
      .from(claims)
      .where(eq(claims.paperId, p.id));
    const missingClaims = paperClaims.filter((c) => !embeddedClaims.has(c.id));
    const needSummary = !embeddedPapers.has(p.id);

    if (missingClaims.length === 0 && !needSummary) continue;

    let summary: string | null = null;
    if (needSummary) {
      const [ext] = await db
        .select({
          problem: extractions.problem,
          method: extractions.method,
          results: extractions.results,
          limitations: extractions.limitations,
        })
        .from(extractions)
        .where(eq(extractions.paperId, p.id))
        .limit(1);
      summary = ext ? buildPaperSummary(ext) : null;
    }

    const r = await embedAndStorePaper({
      paperId: p.id,
      claims: missingClaims,
      summary,
    });
    claimCount += r.claimCount;
    if (r.paperSummary) paperCount += 1;
    papersTouched += 1;
  }

  console.log("");
  console.log(`papers touched:     ${papersTouched}`);
  console.log(`claim embeddings:   ${claimCount}`);
  console.log(`paper embeddings:   ${paperCount}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Backfill failed:");
    console.error(error);
    process.exit(1);
  });
