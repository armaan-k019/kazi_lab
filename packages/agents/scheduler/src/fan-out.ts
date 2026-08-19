import { inArray, sql } from "drizzle-orm";
import { db, libraries } from "@kazi-lab/db";
import { detectStaleStates, estimateTaskCost, PRIORITY, type DetectedTask, type DetectionResult } from "./detection";
import { buildCorpusSnapshot } from "./snapshot";
import { scheduleApprovableRun } from "./schedule";
import { executeApprovedTasks, type TaskExecutionResult } from "./execute";

// Phase 2 default: the three libraries known to be metric-missing today.
export const DEFAULT_FAN_OUT_LIBRARIES = ["generative-3d", "urban-heat", "cosmic-structure"];

export type FanOutLibraryReport = {
  library: string;
  metricRowsBefore: number;
  metricRowsAfter: number;
  rowsExtracted: number;
  status: "completed" | "failed" | "skipped";
  elapsedMs: number | null;
  error: string | null;
};

export type FanOutReport = {
  runId: string;
  libraries: FanOutLibraryReport[];
  detectionAfter: { metricsMissing: number; missingLibraries: string[] };
};

async function metricRowsByLibrary(libraryIds: string[]): Promise<Map<string, number>> {
  if (libraryIds.length === 0) return new Map();
  const rows = await db
    .execute<{ library_id: string; c: number }>(sql`
      select pl.library_id, count(*)::int c
      from paper_metrics m join paper_libraries pl on pl.paper_id = m.paper_id
      where pl.library_id in (${sql.join(libraryIds.map((id) => sql`${id}`), sql`, `)})
      group by pl.library_id`)
    .then((r) => r.rows);
  return new Map(rows.map((r) => [r.library_id, r.c]));
}

// Metric extraction fan-out: one scheduler run holding one auto-approved
// extract_metrics task per library, executed sequentially (the execution
// engine spaces tasks 5s apart), then a fresh detection pass so the
// scheduler's picture reflects the new coverage. Idempotent: the underlying
// CLI runs ONLY_MISSING, so re-running skips papers that already have rows.
export async function extractMetricsMultiLibrary(libraryNames: string[] = DEFAULT_FAN_OUT_LIBRARIES): Promise<FanOutReport> {
  const rows = await db
    .select({ id: libraries.id, name: libraries.name })
    .from(libraries)
    .where(inArray(libraries.name, libraryNames));
  const found = new Map(rows.map((r) => [r.name, r.id]));
  const missing = libraryNames.filter((n) => !found.has(n));

  const passStart = new Date();
  const tasks: DetectedTask[] = [...found.entries()].map(([name, id]) => {
    const { usd, tokens } = estimateTaskCost("extract_metrics", 1);
    return {
      kind: "extract_metrics",
      scope: [id],
      scopeNames: [name],
      priority: PRIORITY.extract_metrics,
      reason: "metric extraction fan-out (Phase 2)",
      costEstimateUsd: usd,
      costEstimateTokens: tokens,
      approvalRequired: false,
    };
  });
  const detection: DetectionResult = {
    tasks,
    diagnostics: [],
    stats: {
      totalLibraries: tasks.length,
      synthesizedLibraries: 0,
      librariesWithMetrics: 0,
      synthesisStale: 0,
      metricsMissing: tasks.length,
      crossDomainMissing: 0,
      proposalsMissing: 0,
      apiFailures24h: 0,
    },
  };

  const before = await metricRowsByLibrary([...found.values()]);
  const summary = await scheduleApprovableRun(
    detection,
    passStart,
    new Date(),
    `metric extraction fan-out over ${[...found.keys()].join(", ")}${missing.length ? `; not found: ${missing.join(", ")}` : ""}`,
  );
  const report = await executeApprovedTasks(summary.runId);
  const after = await metricRowsByLibrary([...found.values()]);

  const byName = new Map<string, TaskExecutionResult>();
  for (const r of report.results) {
    if (r.scopeNames[0]) byName.set(r.scopeNames[0], r);
  }
  const libReports: FanOutLibraryReport[] = libraryNames.map((name) => {
    const id = found.get(name);
    if (!id) {
      return { library: name, metricRowsBefore: 0, metricRowsAfter: 0, rowsExtracted: 0, status: "skipped", elapsedMs: null, error: "library not found" };
    }
    const r = byName.get(name);
    const b = before.get(id) ?? 0;
    const a = after.get(id) ?? 0;
    return {
      library: name,
      metricRowsBefore: b,
      metricRowsAfter: a,
      rowsExtracted: a - b,
      status: r ? r.status : "skipped",
      elapsedMs: r?.elapsedMs ?? null,
      error: r?.error ?? null,
    };
  });

  // Fresh detection so the scheduler's picture updates (missing-metrics
  // diagnostics disappear for covered libraries). Not persisted: this is the
  // report's view; the next real detection run persists its own snapshot.
  const snap = await buildCorpusSnapshot();
  const detect = detectStaleStates(snap);
  const stillMissing = detect.tasks.filter((t) => t.kind === "extract_metrics").flatMap((t) => t.scopeNames);

  return {
    runId: summary.runId,
    libraries: libReports,
    detectionAfter: { metricsMissing: stillMissing.length, missingLibraries: stillMissing },
  };
}
