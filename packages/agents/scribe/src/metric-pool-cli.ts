import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

// Data-quality / pooling report for a library's metrics (default "spatial").
// Three additive, non-destructive steps:
//   1. Backfill the canonical *_canon fields from *_norm via the auditable alias
//      map (raw + norm rows untouched). Reports every merge with row counts.
//   2. Dedup for pooling: within a (dataset, metric, task, CONDITIONS) bucket,
//      collapse rows that are the same (method, value) across papers into one
//      result, prefer the self-report, preserve provenance, and FLAG value
//      disagreements instead of silently picking. Conditions are part of the key
//      on purpose: the same method under different conditions (per-scene PSNR,
//      class vs instance mIoU, point counts) is a different result, NOT a
//      conflict, so it must not be flagged or collapsed.
//   3. Print the post-clean readiness report: true distinct-method/paper counts
//      per top key + dispersion availability + flagged conflicts.
// This is a read/report layer plus an additive backfill. Raw rows are not deleted.

// Two values for the SAME (method, key, conditions) within this tolerance are the
// same result (rounding/reporting noise). A larger gap is a real disagreement and
// is flagged, never silently merged.
const CONFLICT_TOLERANCE = 0.15;
// Bucket label for rows that report no qualifying conditions (the headline
// number). These are the cleanest pool members.
const DEFAULT_COND = "(default)";

async function main(): Promise<void> {
  const libArg = process.argv[2] ?? "spatial";
  const { eq, sql } = await import("drizzle-orm");
  const { db, libraries } = await import("@kazi-lab/db");
  const { DATASET_ALIASES, METRIC_ALIASES, TASK_ALIASES, DELIBERATE_NON_MERGES } =
    await import("./metric-aliases");

  const [lib] = await db
    .select({ id: libraries.id, name: libraries.name })
    .from(libraries)
    .where(eq(libraries.name, libArg))
    .limit(1);
  if (!lib) {
    console.error(`Library not found: ${libArg}`);
    process.exit(1);
  }
  const libId = lib.id;
  const inLib = sql`m.paper_id in (select paper_id from paper_libraries where library_id = ${libId})`;

  // --- STEP 1: backfill canonical fields (additive) -----------------------
  // Baseline: canon = norm/task for every row in this library.
  await db.execute(sql`
    update paper_metrics m
    set dataset_canon = m.dataset_norm,
        metric_canon = m.metric_norm,
        task_canon = m.task
    where ${inLib}`);

  console.log("=== ALIAS MERGES APPLIED (from -> to : rows affected) ===");
  const reportMerges = async (
    col: "dataset_norm" | "metric_norm" | "task",
    canonCol: "dataset_canon" | "metric_canon" | "task_canon",
    map: Record<string, string>,
    label: string,
  ) => {
    const entries = Object.entries(map);
    if (entries.length === 0) {
      console.log(`  ${label}: (none)`);
      return;
    }
    for (const [from, to] of entries) {
      const res = await db.execute(sql`
        update paper_metrics m
        set ${sql.raw(canonCol)} = ${to}
        where ${inLib} and m.${sql.raw(col)} = ${from}`);
      const n = (res as { rowCount?: number }).rowCount ?? 0;
      console.log(`  ${label}: "${from}" -> "${to}" : ${n} rows`);
    }
  };
  await reportMerges("dataset_norm", "dataset_canon", DATASET_ALIASES, "dataset");
  await reportMerges("metric_norm", "metric_canon", METRIC_ALIASES, "metric");
  await reportMerges("task", "task_canon", TASK_ALIASES, "task");

  console.log("\n=== DELIBERATE NON-MERGES (kept separate on purpose) ===");
  for (const n of DELIBERATE_NON_MERGES) console.log(`  ${n}`);

  // --- coverage -----------------------------------------------------------
  const cov = (await db.execute<{
    total_papers: number;
    with_metrics: number;
    total_rows: number;
    with_disp: number;
    with_n: number;
  }>(sql`
    with libp as (select paper_id from paper_libraries where library_id = ${libId})
    select (select count(*)::int from libp) total_papers,
           (select count(distinct m.paper_id)::int from paper_metrics m where ${inLib}) with_metrics,
           (select count(*)::int from paper_metrics m where ${inLib}) total_rows,
           (select count(*)::int from paper_metrics m where ${inLib} and m.dispersion is not null) with_disp,
           (select count(*)::int from paper_metrics m where ${inLib} and m.sample_size is not null) with_n`)).rows[0];

  // --- STEP 2 + 3: load rows, dedup in JS, build pooling report -----------
  const rows = (await db.execute<{
    paper_id: string;
    parse_path: string | null;
    title: string;
    method_name: string | null;
    is_self: boolean | null;
    dataset_canon: string | null;
    metric_canon: string | null;
    task_canon: string | null;
    value: string | null;
    conditions: string | null;
    dispersion: string | null;
  }>(sql`
    select m.paper_id, p.parse_path, p.title, m.method_name, m.is_self,
           m.dataset_canon, m.metric_canon, m.task_canon, m.value,
           m.conditions, m.dispersion
    from paper_metrics m
    join papers p on p.id = m.paper_id
    where ${inLib}
      and m.dataset_canon is not null and m.metric_canon is not null
      and m.method_name is not null and m.value is not null`)).rows;

  type ValueGroup = { value: number; papers: Set<string>; selfPapers: Set<string> };
  // method -> conditions -> value groups
  type MethodAgg = { method: string; conds: Map<string, ValueGroup[]> };
  type KeyAgg = {
    dataset: string;
    metric: string;
    task: string;
    rawRows: number;
    methods: Map<string, MethodAgg>;
    papers: Set<string>;
    dispRows: number;
  };
  const keys = new Map<string, KeyAgg>();
  const labelOf = (p: { parse_path: string | null; title: string }) =>
    p.parse_path ?? p.title.slice(0, 24);

  for (const r of rows) {
    const dataset = r.dataset_canon as string;
    const metric = r.metric_canon as string;
    const task = r.task_canon ?? "";
    const k = `${dataset} ${metric} ${task}`;
    let agg = keys.get(k);
    if (!agg) {
      agg = { dataset, metric, task, rawRows: 0, methods: new Map(), papers: new Set(), dispRows: 0 };
      keys.set(k, agg);
    }
    agg.rawRows++;
    agg.papers.add(r.paper_id);
    if (r.dispersion != null) agg.dispRows++;
    const method = r.method_name as string;
    const value = Number(r.value);
    if (!Number.isFinite(value)) continue;
    const cond = (r.conditions ?? "").trim() || DEFAULT_COND;
    let ma = agg.methods.get(method);
    if (!ma) {
      ma = { method, conds: new Map() };
      agg.methods.set(method, ma);
    }
    let groups = ma.conds.get(cond);
    if (!groups) {
      groups = [];
      ma.conds.set(cond, groups);
    }
    // Same value within the SAME conditions collapses; different value in the
    // same conditions is a genuine disagreement (a new group, later flagged).
    let vg = groups.find((g) => Math.abs(g.value - value) <= CONFLICT_TOLERANCE);
    if (!vg) {
      vg = { value, papers: new Set(), selfPapers: new Set() };
      groups.push(vg);
    }
    vg.papers.add(labelOf(r));
    if (r.is_self) vg.selfPapers.add(labelOf(r));
  }

  type Conflict = { method: string; cond: string; values: number[] };
  type KeyReport = {
    dataset: string;
    metric: string;
    task: string;
    rawRows: number;
    papers: number;
    distinctMethods: number; // distinct methods over all conditions
    primaryMethods: number; // distinct methods with a headline (no-conditions) number
    pooledResults: number; // distinct (method, conditions, value) after collapse
    conflicts: Conflict[]; // same (method, conditions), different value
    dispRows: number;
  };
  const reports: KeyReport[] = [];
  for (const agg of keys.values()) {
    let pooled = 0;
    let primaryMethods = 0;
    const conflicts: Conflict[] = [];
    for (const ma of agg.methods.values()) {
      if (ma.conds.has(DEFAULT_COND)) primaryMethods++;
      for (const [cond, groups] of ma.conds) {
        pooled += groups.length;
        if (groups.length > 1) {
          conflicts.push({
            method: ma.method,
            cond,
            values: groups.map((g) => g.value).sort((a, b) => a - b),
          });
        }
      }
    }
    reports.push({
      dataset: agg.dataset,
      metric: agg.metric,
      task: agg.task,
      rawRows: agg.rawRows,
      papers: agg.papers.size,
      distinctMethods: agg.methods.size,
      primaryMethods,
      pooledResults: pooled,
      conflicts,
      dispRows: agg.dispRows,
    });
  }
  reports.sort(
    (a, b) => b.primaryMethods - a.primaryMethods || b.distinctMethods - a.distinctMethods,
  );

  console.log("\n=== COVERAGE (post-clean) ===");
  console.log(
    `papers with metrics / total: ${cov.with_metrics}/${cov.total_papers} | total rows: ${cov.total_rows}`,
  );
  console.log(
    `rows with dispersion: ${cov.with_disp}/${cov.total_rows} | rows with sample_size: ${cov.with_n}/${cov.total_rows}`,
  );

  console.log("\n=== TOP POOLABLE KEYS (post canon + conditions-aware dedup) ===");
  console.log(
    "  dataset | metric | task : PRIMARY methods (headline, no-conditions) / DISTINCT methods (all conditions) across N papers | raw rows | pooled results | dispersion rows | real conflicts",
  );
  for (const r of reports.slice(0, 15)) {
    console.log(
      `  ${r.dataset} | ${r.metric} | ${r.task || "(none)"} : ${r.primaryMethods} primary / ${r.distinctMethods} all / ${r.papers} papers | raw ${r.rawRows} | pooled ${r.pooledResults} | disp ${r.dispRows} | conflicts ${r.conflicts.length}`,
    );
  }

  // --- worked example: top key (ModelNet40 accuracy classification) -------
  const example =
    reports.find(
      (r) =>
        r.dataset === "ModelNet40" &&
        r.metric === "accuracy" &&
        r.task === "classification",
    ) ?? reports[0];
  if (example) {
    const k = `${example.dataset} ${example.metric} ${example.task}`;
    const agg = keys.get(k)!;
    console.log(
      `\n=== WORKED DEDUP EXAMPLE: ${example.dataset} | ${example.metric} | ${example.task} ===`,
    );
    console.log(
      `raw rows: ${example.rawRows} -> distinct methods: ${example.distinctMethods} (primary/headline: ${example.primaryMethods}) across ${example.papers} papers; pooled results: ${example.pooledResults}`,
    );
    // A method re-reported across multiple papers with the SAME value (self wins).
    let shown = false;
    for (const ma of agg.methods.values()) {
      const g = ma.conds.get(DEFAULT_COND)?.[0];
      if (g && g.papers.size > 1 && ma.conds.get(DEFAULT_COND)!.length === 1) {
        console.log(
          `  collapsed re-report: "${ma.method}" = ${g.value} (headline) reported by ${g.papers.size} papers [${[...g.papers].join(", ")}] -> 1 result; self-authoritative: ${g.selfPapers.size ? [...g.selfPapers].join(", ") : "(all re-reports, no self present)"}`,
        );
        shown = true;
        break;
      }
    }
    if (!shown) console.log("  (no multi-paper collapsed headline result in this key)");
    if (example.conflicts.length > 0) {
      console.log("  FLAGGED disagreements (same method + same conditions, different value, kept distinct):");
      for (const c of example.conflicts) {
        const groups = agg.methods.get(c.method)!.conds.get(c.cond)!;
        const detail = groups
          .map((g) => `${g.value}${g.selfPapers.size ? "(self)" : ""}[${[...g.papers].join(",")}]`)
          .join(" vs ");
        console.log(`    "${c.method}" @ ${c.cond}: ${detail}`);
      }
    } else {
      console.log("  no genuine (conditions-held) disagreements flagged for this key.");
    }
  }

  // --- all genuine conflicts across top keys ------------------------------
  console.log("\n=== ALL GENUINE VALUE DISAGREEMENTS (top 15 keys, conditions held constant) ===");
  let any = false;
  for (const r of reports.slice(0, 15)) {
    for (const c of r.conflicts) {
      any = true;
      console.log(
        `  ${r.dataset}|${r.metric}|${r.task || "(none)"} :: "${c.method}" @ ${c.cond} = ${c.values.join(" vs ")}`,
      );
    }
  }
  if (!any) console.log("  (none in top 15 keys)");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Metric pool report failed:");
    console.error(error);
    process.exit(1);
  });
