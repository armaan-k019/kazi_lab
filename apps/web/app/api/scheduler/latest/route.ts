import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { db, libraries, schedulerDiagnostics, schedulerRuns, schedulerTasks } from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The latest scheduler run with its tasks and diagnostics, plus the env-level
// scheduler config (documented defaults when unset).
export async function GET() {
  try {
    const config = {
      enabled: process.env.SCHEDULER_ENABLED !== "false",
      intervalMinutes: Number(process.env.SCHEDULER_INTERVAL_MINUTES) > 0 ? Number(process.env.SCHEDULER_INTERVAL_MINUTES) : 60,
    };

    const [run] = await db.select().from(schedulerRuns).orderBy(desc(schedulerRuns.createdAt)).limit(1);
    if (!run) {
      return NextResponse.json({ config, run: null, tasks: [], diagnostics: [] });
    }

    const tasks = await db
      .select()
      .from(schedulerTasks)
      .where(eq(schedulerTasks.runId, run.id))
      .orderBy(desc(schedulerTasks.priority), schedulerTasks.createdAt);
    const diagnostics = await db
      .select()
      .from(schedulerDiagnostics)
      .where(eq(schedulerDiagnostics.runId, run.id));

    const libIds = [
      ...new Set([...tasks.flatMap((t) => t.scope), ...diagnostics.map((d) => d.affectedLibraryId).filter((x): x is string => x !== null)]),
    ];
    const names = libIds.length
      ? await db.select({ id: libraries.id, name: libraries.name }).from(libraries).where(inArray(libraries.id, libIds))
      : [];
    const nameBy = new Map(names.map((r) => [r.id, r.name]));

    return NextResponse.json({
      config,
      run: {
        id: run.id,
        status: run.status,
        detectionPassStart: run.detectionPassStart,
        detectionPassEnd: run.detectionPassEnd,
        tasksQueued: run.tasksQueued,
        tasksApproved: run.tasksApproved,
        tasksExecuted: run.tasksExecuted,
        tasksFailed: run.tasksFailed,
        stats: run.stats,
        notes: run.notes,
        createdAt: run.createdAt,
      },
      tasks: tasks.map((t) => ({
        id: t.id,
        kind: t.kind,
        scopeNames: t.scope.map((id) => nameBy.get(id) ?? id),
        priority: t.priority,
        costEstimateUsd: t.costEstimateUsd,
        costEstimateTokens: t.costEstimateTokens,
        status: t.status,
        approvalRequired: t.approvalRequired,
        humanApprovalAt: t.humanApprovalAt,
        humanApprovalBy: t.humanApprovalBy,
        commandResult: t.commandResult,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
      })),
      diagnostics: diagnostics.map((d) => ({
        id: d.id,
        kind: d.diagnosticKind,
        libraryName: d.affectedLibraryId ? (nameBy.get(d.affectedLibraryId) ?? d.affectedLibraryId) : null,
        details: d.details,
      })),
    });
  } catch (error) {
    console.error("GET /api/scheduler/latest failed:", error);
    return NextResponse.json({ error: "Failed to load the scheduler state." }, { status: 500 });
  }
}
