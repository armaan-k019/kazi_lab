import { NextResponse } from "next/server";
import { executeApprovedTasks } from "@kazi-lab/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Sequential agent runs; metric extraction over a full library can take a
// while. Awaited on the long-lived local Node server.
export const maxDuration = 3600;

// Execute the approved tasks on a run (default: latest awaiting/executing).
// Each task wraps an existing agent CLI; per-task status and results are
// recorded, and one failure never aborts the remaining tasks.
export async function POST(request: Request) {
  let runId: string | undefined;
  try {
    const body = (await request.json()) as { runId?: string };
    if (typeof body.runId === "string") runId = body.runId;
  } catch {
    // Empty body: latest run.
  }
  try {
    const report = await executeApprovedTasks(runId);
    if (!report.runId) {
      return NextResponse.json({ error: "No scheduler run with approved tasks to execute." }, { status: 422 });
    }
    return NextResponse.json(report);
  } catch (error) {
    console.error("POST /api/scheduler/execute failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Execution failed: ${message}` }, { status: 500 });
  }
}
