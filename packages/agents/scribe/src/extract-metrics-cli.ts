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

  const libPapers = await db
    .select({ id: papers.id, title: papers.title, parsePath: papers.parsePath })
    .from(papers)
    .innerJoin(paperLibraries, eq(paperLibraries.paperId, papers.id))
    .where(eq(paperLibraries.libraryId, lib.id));

  console.log(`Extracting metrics for ${libPapers.length} papers in "${lib.name}"...\n`);
  let withMetrics = 0;
  let zero = 0;
  let skipped = 0;
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
      console.log(`  SKIP ${p.title.slice(0, 50)} :: ${(e as Error).message.slice(0, 100)}`);
    }
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

  console.log("\n=== COVERAGE ===");
  console.log(`papers: ${libPapers.length} | with metrics: ${withMetrics} | zero: ${zero} | skipped: ${skipped}`);
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
