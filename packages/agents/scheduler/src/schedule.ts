import { db, schedulerDiagnostics, schedulerRuns, schedulerTasks } from "@kazi-lab/db";
import { describeTask, type DetectionResult } from "./detection";

export type ScheduledTaskSummary = {
  id: string;
  kind: string;
  scopeNames: string[];
  priority: number;
  costEstimateUsd: number;
  status: string;
  approvalRequired: boolean;
  description: string;
  reason: string;
};

export type ScheduleSummary = {
  runId: string;
  status: string;
  taskCount: number;
  autoApproved: number;
  needsApproval: number;
  totalCostUsd: number;
  totalCostTokens: number;
  tasks: ScheduledTaskSummary[];
  diagnosticCount: number;
};

// Persist one detection pass as an immutable scheduler run: the run row, its
// tasks (auto-approved low-risk kinds start "approved", the rest "queued"),
// and its diagnostics, in one transaction. A failed insert writes nothing.
export async function scheduleApprovableRun(
  detection: DetectionResult,
  passStart: Date,
  passEnd: Date,
  notes?: string,
): Promise<ScheduleSummary> {
  const totalCostUsd = detection.tasks.reduce((s, t) => s + t.costEstimateUsd, 0);
  const totalCostTokens = detection.tasks.reduce((s, t) => s + t.costEstimateTokens, 0);
  const autoApproved = detection.tasks.filter((t) => !t.approvalRequired);

  // A pass with zero tasks is a completed (healthy) snapshot, not a run stuck
  // awaiting approval of nothing.
  const runStatus = detection.tasks.length === 0 ? "completed" : "awaiting_approval";

  const summaryTasks: ScheduledTaskSummary[] = [];
  const runId = await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(schedulerRuns)
      .values({
        detectionPassStart: passStart,
        detectionPassEnd: passEnd,
        status: runStatus,
        tasksQueued: detection.tasks.length,
        tasksApproved: autoApproved.length,
        tasksExecuted: 0,
        tasksFailed: 0,
        stats: detection.stats,
        notes: notes ?? null,
      })
      .returning({ id: schedulerRuns.id });

    for (const t of detection.tasks) {
      const status = t.approvalRequired ? "queued" : "approved";
      const [row] = await tx
        .insert(schedulerTasks)
        .values({
          runId: run.id,
          kind: t.kind,
          scope: t.scope,
          priority: t.priority,
          costEstimateUsd: t.costEstimateUsd,
          costEstimateTokens: t.costEstimateTokens,
          status,
          approvalRequired: t.approvalRequired,
          humanApprovalBy: t.approvalRequired ? null : "auto-approved: low-risk idempotent kind",
          commandResult: { reason: t.reason, scopeNames: t.scopeNames },
        })
        .returning({ id: schedulerTasks.id });
      summaryTasks.push({
        id: row.id,
        kind: t.kind,
        scopeNames: t.scopeNames,
        priority: t.priority,
        costEstimateUsd: t.costEstimateUsd,
        status,
        approvalRequired: t.approvalRequired,
        description: describeTask(t),
        reason: t.reason,
      });
    }

    if (detection.diagnostics.length > 0) {
      await tx.insert(schedulerDiagnostics).values(
        detection.diagnostics.map((d) => ({
          runId: run.id,
          diagnosticKind: d.kind,
          affectedLibraryId: d.affectedLibraryId,
          details: d.details,
        })),
      );
    }
    return run.id;
  });

  return {
    runId,
    status: runStatus,
    taskCount: detection.tasks.length,
    autoApproved: autoApproved.length,
    needsApproval: detection.tasks.length - autoApproved.length,
    totalCostUsd: Math.round(totalCostUsd * 100) / 100,
    totalCostTokens,
    tasks: summaryTasks,
    diagnosticCount: detection.diagnostics.length,
  };
}
