import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

// Metric extraction fan-out (Phase 2). Sequential, idempotent, per-library
// reporting. Usage: pnpm --filter @kazi-lab/scheduler fan-out [names...]
async function main(): Promise<void> {
  const names = process.argv.slice(2);
  const { extractMetricsMultiLibrary, DEFAULT_FAN_OUT_LIBRARIES } = await import("./fan-out");
  const report = await extractMetricsMultiLibrary(names.length ? names : DEFAULT_FAN_OUT_LIBRARIES);
  console.log(`=== METRIC FAN-OUT (scheduler run ${report.runId}) ===`);
  for (const l of report.libraries) {
    console.log(`\n${l.library}: ${l.status}${l.elapsedMs !== null ? ` in ${Math.round(l.elapsedMs / 1000)}s` : ""}`);
    console.log(`  metric rows: ${l.metricRowsBefore} -> ${l.metricRowsAfter} (+${l.rowsExtracted})`);
    if (l.error) console.log(`  error: ${l.error}`);
  }
  console.log(`\nDetection after: ${report.detectionAfter.metricsMissing} libraries still metric-missing${report.detectionAfter.missingLibraries.length ? ` (${report.detectionAfter.missingLibraries.join(", ")})` : ""}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Fan-out failed:");
  console.error(error);
  process.exit(1);
});
