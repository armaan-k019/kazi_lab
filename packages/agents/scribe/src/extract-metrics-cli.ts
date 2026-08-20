import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SPACING_MS = 2000;

// Extract structured metrics for every paper in a library (default "spatial"),
// then report coverage + the top shared (dataset, metric, task) keys + an honest
// poolability read. Sequential, non-fatal (skip-and-report). Idempotent.
async function main(): Promise<void> {
  const libArg = process.argv[2] ?? "spatial";
  const { eq, sql } = await import("drizzle-orm");
  const { db, libraries, paperLibraries, papers, paperMetrics } = await import(
    "@kazi-lab/db"
  );
  const { extractPaperMetrics } = await import("./extract-metrics");

  const [lib] = await db
    .select({ id: libraries.id, name: libraries.name })
    .from(libraries)
    .where(eq(libraries.name, libArg))
    .limit(1);
  if (!lib) {
    console.error(`Library not found: ${libArg}`);
    process.exit(1);
  }

  const allLibPapers = await db
    .select({ id: papers.id, title: papers.title, parsePath: papers.parsePath })
    .from(papers)
    .innerJoin(paperLibraries, eq(paperLibraries.paperId, papers.id))
    .where(eq(paperLibraries.libraryId, lib.id));

  // ONLY_MISSING re-runs only papers that currently have zero metric rows
  // (recover transient skips / truncations), idempotently.
  let libPapers = allLibPapers;
  if (process.env.ONLY_MISSING === "1") {
    const counts = await db
      .select({ paperId: paperMetrics.paperId, c: sql<number>`count(*)::int` })
      .from(paperMetrics)
      .groupBy(paperMetrics.paperId);
    const have = new Set(counts.filter((r) => r.c > 0).map((r) => r.paperId));
    libPapers = allLibPapers.filter((p) => !have.has(p.id));
  }

  console.log(
    `Extracting metrics for ${libPapers.length}/${allLibPapers.length} papers in "${lib.name}"${process.env.ONLY_MISSING === "1" ? " (only-missing)" : ""}...\n`,
  );
  let withMetrics = 0;
  let zero = 0;
  let skipped = 0;
  const skipErrorCounts = new Map<string, number>();
  for (let i = 0; i < libPapers.length; i++) {
    const p = libPapers[i];
    if (i > 0) await sleep(SPACING_MS);
    try {
      const r = await extractPaperMetrics(p.id);
      if (r.count > 0) withMetrics++;
      else zero++;
      console.log(
        `  [${p.parsePath ?? "?"}] metrics=${r.count}${r.note ? ` (${r.note})` : ""}: ${p.title.slice(0, 50)}`,
      );
    } catch (e) {
      skipped++;
      const msg = (e as Error).message.slice(0, 160);
      skipErrorCounts.set(msg, (skipErrorCounts.get(msg) ?? 0) + 1);
      console.log(`  SKIP ${p.title.slice(0, 50)} :: ${msg.slice(0, 100)}`);
    }
  }

  // EXPLICIT OUTCOME (machine-readable; the scheduler stores it). A zero-row
  // result must always carry its explanation: "genuinely no metrics" and
  // "every call failed" are different worlds, and the silent zero that hid a
  // systemic 401 behind per-paper skips was the actual bug.
  const dominantError = [...skipErrorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const outcome = {
    library: lib.name,
    papersProcessed: libPapers.length,
    withMetrics,
    zeroMetrics: zero,
    skipped,
    dominantError,
  };
  console.log(`\nMETRICS_OUTCOME_JSON: ${JSON.stringify(outcome)}`);
  if (libPapers.length > 0 && skipped === libPapers.length) {
    console.error(
      `\nSYSTEMIC FAILURE: every one of ${libPapers.length} papers failed. Dominant error: ${dominantError}`,
    );
    console.error("Nothing was extracted; this run must not be recorded as a success.");
    process.exit(1);
  }
  if (libPapers.length > 0 && withMetrics === 0 && skipped === 0) {
    console.log(
      `OUTCOME: no extractable metrics found; ${libPapers.length} papers scanned cleanly. This is a real result, not an error.`,
    );
  }

  // Corpus-level coverage over this library's metrics.
  const libId = lib.id;
  const [{ total }] = await db.execute<{ total: number }>(sql`
    select count(*)::int total from paper_metrics m
    join paper_libraries pl on pl.paper_id = m.paper_id
    where pl.library_id = ${libId}`).then((r) => r.rows);
  const [{ distinct_keys }] = await db.execute<{ distinct_keys: number }>(sql`
    select count(distinct (m.dataset_norm, m.metric_norm, coalesce(m.task,'')))::int distinct_keys
    from paper_metrics m join paper_libraries pl on pl.paper_id = m.paper_id
    where pl.library_id = ${libId}`).then((r) => r.rows);
  const [{ with_disp, with_n }] = await db.execute<{ with_disp: number; with_n: number }>(sql`
    select sum((m.dispersion is not null)::int)::int with_disp,
           sum((m.sample_size is not null)::int)::int with_n
    from paper_metrics m join paper_libraries pl on pl.paper_id = m.paper_id
    where pl.library_id = ${libId}`).then((r) => r.rows);

  // Top shared keys: (dataset, metric, task) appearing across the most papers.
  const topKeys = (await db.execute<{
    dataset_norm: string;
    metric_norm: string;
    task: string;
    papers: number;
    methods: number;
    rows: number;
  }>(sql`
    select m.dataset_norm, m.metric_norm, coalesce(m.task,'') task,
           count(distinct m.paper_id)::int papers,
           count(distinct m.method_name)::int methods,
           count(*)::int rows
    from paper_metrics m join paper_libraries pl on pl.paper_id = m.paper_id
    where pl.library_id = ${libId} and m.dataset_norm is not null and m.metric_norm is not null
    group by m.dataset_norm, m.metric_norm, coalesce(m.task,'')
    order by papers desc, rows desc
    limit 12`)).rows;

  console.log("\n=== COVERAGE (this run) ===");
  console.log(`library papers: ${allLibPapers.length} | processed: ${libPapers.length} | with metrics: ${withMetrics} | zero: ${zero} | skipped: ${skipped}`);
  console.log(`total metric rows: ${total} | distinct (dataset,metric,task) keys: ${distinct_keys}`);
  console.log(`rows with dispersion: ${with_disp ?? 0}/${total} | rows with sample_size: ${with_n ?? 0}/${total}`);
  console.log("\n=== TOP SHARED KEYS (dataset | metric | task : papers, methods, rows) ===");
  for (const k of topKeys) {
    console.log(`  ${k.dataset_norm} | ${k.metric_norm} | ${k.task || "(none)"} : ${k.papers} papers, ${k.methods} methods, ${k.rows} rows`);
  }

  // A few example rows for eyeballing accuracy.
  const examples = (await db.execute<{
    method_name: string;
    is_self: boolean;
    dataset_norm: string;
    metric_norm: string;
    value: string;
    unit: string;
    source_excerpt: string;
  }>(sql`
    select m.method_name, m.is_self, m.dataset_norm, m.metric_norm, m.value, m.unit, m.source_excerpt
    from paper_metrics m join paper_libraries pl on pl.paper_id = m.paper_id
    where pl.library_id = ${libId}
    order by m.dataset_norm, m.metric_norm limit 8`)).rows;
  console.log("\n=== EXAMPLE ROWS ===");
  for (const e of examples) {
    console.log(`  ${e.method_name}${e.is_self ? " (self)" : ""} | ${e.dataset_norm} | ${e.metric_norm} = ${e.value}${e.unit ?? ""} | src: "${(e.source_excerpt ?? "").slice(0, 70)}"`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Metric extraction run failed:");
    console.error(error);
    process.exit(1);
  });
