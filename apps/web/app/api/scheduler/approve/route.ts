import { NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schedulerRuns, schedulerTasks } from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  action?: "approve" | "defer" | "reject";
  taskId?: string;
  runId?: string; // with all: true
  all?: boolean;
  note?: string;
};

// Human approval workflow: approve, defer, or reject one queued task, or all
// queued tasks on a run. Only queued tasks transition here; executing and
// finished tasks are immutable history.
export async function POST(request: Request) {
  let body: Body = {};
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "A JSON body is required." }, { status: 400 });
  }
  const action = body.action ?? "approve";
  if (!["approve", "defer", "reject"].includes(action)) {
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
  const nextStatus = action === "approve" ? "approved" : action === "defer" ? "deferred" : "rejected";
  if (!body.taskId && !(body.all && body.runId)) {
    return NextResponse.json({ error: "Pass taskId, or runId with all: true." }, { status: 400 });
  }

  try {
    const updated = await db.transaction(async (tx) => {
      let taskIds: string[] = [];
      if (body.all && body.runId) {
        const rows = await tx
          .select({ id: schedulerTasks.id })
          .from(schedulerTasks)
          .where(and(eq(schedulerTasks.runId, body.runId), eq(schedulerTasks.status, "queued")));
        taskIds = rows.map((r) => r.id);
      } else if (body.taskId) {
        taskIds = [body.taskId];
      } else {
        throw new Error("Pass taskId, or runId with all: true.");
      }
      if (taskIds.length === 0) return [];

      const rows = await tx
        .update(schedulerTasks)
        .set({
          status: nextStatus,
          humanApprovalAt: new Date(),
          humanApprovalBy: body.note ?? `${action}d via UI`,
        })
        .where(and(inArray(schedulerTasks.id, taskIds), eq(schedulerTasks.status, "queued")))
        .returning({ id: schedulerTasks.id, runId: schedulerTasks.runId });

      // Keep the run's approved counter in step (approvals only).
      if (rows.length > 0 && action === "approve") {
        await tx
          .update(schedulerRuns)
          .set({ tasksApproved: sql`${schedulerRuns.tasksApproved} + ${rows.length}` })
          .where(eq(schedulerRuns.id, rows[0].runId));
      }
      return rows;
    });

    return NextResponse.json({ action, updated: updated.length });
  } catch (error) {
    console.error("POST /api/scheduler/approve failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
