import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

// Run one detection pass. DRY_RUN=1 prints without persisting a run.
// Usage: pnpm --filter @kazi-lab/scheduler detect [thresholdDays]
async function main(): Promise<void> {
  const thresholdDays = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 30;
  const { buildCorpusSnapshot } = await import("./snapshot");
  const { detectStaleStates, describeTask } = await import("./detection");
  const { scheduleApprovableRun } = await import("./schedule");

  const passStart = new Date();
  const snapshot = await buildCorpusSnapshot(passStart);
  const detection = detectStaleStates(snapshot, thresholdDays);
  const passEnd = new Date();

  console.log(`=== DETECTION (threshold ${thresholdDays}d) ===`);
  console.log(`libraries: ${detection.stats.totalLibraries} | synthesized: ${detection.stats.synthesizedLibraries} | with metrics: ${detection.stats.librariesWithMetrics}`);
  console.log(`stale synthesis: ${detection.stats.synthesisStale} | metrics missing: ${detection.stats.metricsMissing} | cross-domain missing: ${detection.stats.crossDomainMissing} | proposals missing: ${detection.stats.proposalsMissing} | api failures 24h: ${detection.stats.apiFailures24h}`);
  console.log(`\n=== TASKS (${detection.tasks.length}) ===`);
  for (const t of detection.tasks) console.log(`  [p${t.priority}] ${describeTask(t)}`);
  const total = detection.tasks.reduce((s, t) => s + t.costEstimateUsd, 0);
  console.log(`  total estimated cost: ~$${total.toFixed(2)} (conservative upper bound)`);
  console.log(`\n=== DIAGNOSTICS (${detection.diagnostics.length}) ===`);
  for (const d of detection.diagnostics) console.log(`  ${d.kind}${d.affectedLibraryId ? ` [lib ${d.affectedLibraryId.slice(0, 8)}]` : ""}: ${JSON.stringify(d.details)}`);

  if (process.env.DRY_RUN === "1") {
    console.log("\nDRY RUN: no scheduler run persisted.");
    process.exit(0);
  }

  const summary = await scheduleApprovableRun(detection, passStart, passEnd);
  console.log(`\n=== SCHEDULED ===`);
  console.log(`run: ${summary.runId} (${summary.status})`);
  console.log(`tasks: ${summary.taskCount} (${summary.autoApproved} auto-approved, ${summary.needsApproval} need approval)`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Detection failed:");
  console.error(error);
  process.exit(1);
});
