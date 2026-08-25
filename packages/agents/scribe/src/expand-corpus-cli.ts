import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Load the repo-root .env.local before anything reads DATABASE_URL or API keys.
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

// Controlled corpus expansion via the citation graph (see expansion-config.ts
// for the relevance bar). Fully resumable: run it again after any crash, stop,
// or credit exhaustion and it continues from the checkpoint with no duplicates.
//
// Usage: pnpm --filter @kazi-lab/scribe expand [flags]
//   --status            print the current checkpoint state and exit
//   --report            print the full honest report for the latest run and exit
//   --discover-only     run discovery + evaluation, ingest nothing
//   --target N          target new papers (new runs only; ceiling, not quota)
//   --wave-size N       papers per wave (new runs only)
//   --max-waves N       cap waves THIS invocation (testing/resume control)
//   --max-papers N      cap ingested papers THIS invocation

function flagValue(name: string): number | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}
const hasFlag = (name: string) => process.argv.includes(name);

async function latestRunId(): Promise<string | null> {
  const { desc } = await import("drizzle-orm");
  const { db, expansionRuns } = await import("@kazi-lab/db");
  const [run] = await db.select().from(expansionRuns).orderBy(desc(expansionRuns.createdAt)).limit(1);
  return run?.id ?? null;
}

async function printReport(runId: string): Promise<void> {
  const { expansionReport } = await import("./expand-corpus");
  const r = await expansionReport(runId);
  if (!r) {
    console.log("No expansion run found.");
    return;
  }
  console.log("=== EXPANSION REPORT ===");
  console.log(`run: ${r.run.id} | status: ${r.run.status} | wave: ${r.run.currentWave}`);
  console.log(`notes: ${r.run.notes ?? "(none)"}`);
  console.log(`corpus: ${r.run.corpusSizeStart} -> ${r.corpusNow} (${r.ingested} ingested by this run; target ${r.run.targetNew})`);
  if (r.ingested < r.run.targetNew && (r.run.status === "completed" || r.run.status === "stopped")) {
    console.log(`shortfall vs target: ${r.run.targetNew - r.ingested} (the bar was NOT lowered to close it)`);
  }
  console.log(`candidates discovered: ${r.candidatesTotal} | still eligible+pending: ${r.eligiblePending} | ingested corpus-only (no forced library fit): ${r.corpusOnlyIngested}`);
  console.log("\nskips and failures:");
  for (const [reason, n] of Object.entries(r.skippedByReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}  ${reason}`);
  }
  console.log("\nineligible (relevance bar):");
  const ranked = Object.entries(r.ineligibleByReason).sort((a, b) => b[1] - a[1]);
  for (const [reason, n] of ranked.slice(0, 12)) console.log(`  ${n}  ${reason}`);
  if (ranked.length > 12) console.log(`  ... ${ranked.length - 12} more reason variants`);
  console.log("\nlibrary growth:");
  for (const l of r.libraryGrowth) {
    const d = l.after - l.before;
    console.log(`  ${l.name}: ${l.before} -> ${l.after}${d > 0 ? ` (+${d})` : ""}`);
  }
  console.log("\nfield distribution (corpus share, top 10):");
  const dist = (r.run.fieldDistribution ?? {}) as Record<string, number>;
  for (const [f, s] of Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${f}: ${(s * 100).toFixed(0)}%`);
  }
}

async function printStatus(): Promise<void> {
  const { desc, eq, sql } = await import("drizzle-orm");
  const { db, expansionRuns, expansionCandidates, expansionFrontier } = await import("@kazi-lab/db");
  const [run] = await db.select().from(expansionRuns).orderBy(desc(expansionRuns.createdAt)).limit(1);
  if (!run) {
    console.log("No expansion run exists yet.");
    return;
  }
  const cand = await db
    .select({ status: expansionCandidates.status, n: sql<number>`count(*)::int` })
    .from(expansionCandidates)
    .where(eq(expansionCandidates.runId, run.id))
    .groupBy(expansionCandidates.status);
  const front = await db
    .select({ status: expansionFrontier.status, n: sql<number>`count(*)::int` })
    .from(expansionFrontier)
    .where(eq(expansionFrontier.runId, run.id))
    .groupBy(expansionFrontier.status);
  console.log(`run ${run.id} | status ${run.status} | wave ${run.currentWave} | target ${run.targetNew}`);
  console.log(`frontier: ${front.map((f) => `${f.status}=${f.n}`).join(" ") || "(empty)"}`);
  console.log(`candidates: ${cand.map((c) => `${c.status}=${c.n}`).join(" ") || "(none)"}`);
}

async function main(): Promise<void> {
  if (hasFlag("--status")) {
    await printStatus();
    return;
  }
  if (hasFlag("--report")) {
    const id = await latestRunId();
    if (id) await printReport(id);
    else console.log("No expansion run found.");
    return;
  }

  const { runExpansion } = await import("./expand-corpus");
  const summary = await runExpansion({
    overrides: { targetNew: flagValue("--target"), waveSize: flagValue("--wave-size") },
    maxWaves: flagValue("--max-waves"),
    maxPapers: flagValue("--max-papers"),
    discoverOnly: hasFlag("--discover-only"),
  });
  console.log(`\nInvocation done: ${summary.ingestedThisInvocation} ingested over ${summary.wavesRun} wave(s); stop reason: ${summary.stopReason}`);
  await printReport(summary.runId);
  if (summary.stopReason === "auth_failures") process.exit(2);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Expansion failed (checkpoint preserved; rerun to resume):");
    console.error(error);
    process.exit(1);
  });
