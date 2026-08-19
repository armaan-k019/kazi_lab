import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

// Execute the approved tasks on a scheduler run (default: the latest run
// awaiting approval or executing).
// Usage: pnpm --filter @kazi-lab/scheduler execute [runId]
async function main(): Promise<void> {
  const runId = process.argv[2];
  const { executeApprovedTasks } = await import("./execute");
  const report = await executeApprovedTasks(runId);
  if (!report.runId) {
    console.log("No scheduler run awaiting execution.");
    process.exit(0);
  }
  console.log(`=== EXECUTION (run ${report.runId}) ===`);
  console.log(`executed: ${report.executed} | failed: ${report.failed}`);
  for (const r of report.results) {
    console.log(`\n[${r.status}] ${r.kind} ${r.scopeNames.join(", ")} (${Math.round(r.elapsedMs / 1000)}s)`);
    if (r.error) console.log(`  error: ${r.error}`);
    if (r.summary) console.log(r.summary.split("\n").map((l) => `  | ${l}`).join("\n"));
  }
  process.exit(report.failed > 0 && report.executed === 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Execution failed:");
  console.error(error);
  process.exit(1);
});
