import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Load repo-root .env.local before anything reads DATABASE_URL / API keys.
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SPACING_MS = 2500;

// Re-fetch and re-parse every paper through the upgraded table-aware pipeline
// and overwrite its stored text + parse provenance. TEXT ONLY: this does NOT
// re-run claim extraction or embeddings (that is the next prompt). Idempotent,
// sequential, non-fatal (skip-and-report). Vision is opt-in via VISION=1.
async function main(): Promise<void> {
  const vision = process.env.VISION === "1";
  // Re-process only papers that did not get full text yet (parse_path null or
  // abstract_only), e.g. to retry ones skipped by a transient error.
  const onlyMissing = process.env.ONLY_MISSING === "1";
  const { eq, or, isNull } = await import("drizzle-orm");
  const { db, papers, paperLibraries, libraries } = await import("@kazi-lab/db");
  const { fetchSource } = await import("./fetch-source");
  const { sanitizeText } = await import("./markdown");

  const all = await db
    .select({ id: papers.id, arxivId: papers.arxivId, url: papers.url, title: papers.title })
    .from(papers)
    .where(
      onlyMissing
        ? or(isNull(papers.parsePath), eq(papers.parsePath, "abstract_only"))
        : undefined,
    );
  console.log(
    `Backfilling ${all.length} papers (vision=${vision ? "on" : "off"}, onlyMissing=${onlyMissing})...`,
  );

  let upgraded = 0;
  let skipped = 0;
  const byPath: Record<string, number> = {};

  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    if (i > 0) await sleep(SPACING_MS);
    const source = p.arxivId ?? p.url;
    try {
      const data = await fetchSource(source, { vision });
      await db
        .update(papers)
        .set({
          rawText: sanitizeText(data.rawText), // defensive: no NUL reaches Postgres
          parsePath: data.parsePath,
          tableCount: data.tableCount,
          lastProcessedAt: new Date(),
        })
        .where(eq(papers.id, p.id));
      upgraded++;
      byPath[data.parsePath] = (byPath[data.parsePath] ?? 0) + 1;
      console.log(
        `  ok [${data.parsePath}, tables=${data.tableCount}] ${p.title.slice(0, 52)}`,
      );
    } catch (e) {
      skipped++;
      console.log(`  SKIP ${p.title.slice(0, 52)} :: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  console.log("\n=== TOTALS ===");
  console.log("upgraded:", upgraded, "| skipped:", skipped);
  console.log("by parse path:", JSON.stringify(byPath));

  // Per-library coverage: structured-table readiness.
  const libs = await db
    .select({ id: libraries.id, name: libraries.name })
    .from(libraries);
  console.log("\n=== PER-LIBRARY COVERAGE (structured-table vs flat) ===");
  for (const lib of libs) {
    const rows = await db
      .select({ parsePath: papers.parsePath, tableCount: papers.tableCount })
      .from(papers)
      .innerJoin(paperLibraries, eq(paperLibraries.paperId, papers.id))
      .where(eq(paperLibraries.libraryId, lib.id));
    if (rows.length === 0) continue;
    const structured = rows.filter(
      (r) =>
        (r.parsePath === "arxiv_html" ||
          r.parsePath === "vision" ||
          r.parsePath === "readability_tables") &&
        (r.tableCount ?? 0) >= 1,
    ).length;
    console.log(
      `  ${lib.name}: ${structured}/${rows.length} with structured tables` +
        ` (flat/no-table: ${rows.length - structured})`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Backfill failed:");
    console.error(error);
    process.exit(1);
  });
