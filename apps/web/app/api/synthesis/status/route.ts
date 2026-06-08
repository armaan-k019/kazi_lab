import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, synthesisRuns } from "@kazi-lab/db";
import { countsForRun } from "@/lib/synthesis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Status of a single synthesis run (for polling). Counts included once completed.
export async function GET(request: Request) {
  const runId = new URL(request.url).searchParams.get("runId");
  if (!runId) {
    return NextResponse.json({ error: "runId is required." }, { status: 400 });
  }

  try {
    const [run] = await db
      .select({
        id: synthesisRuns.id,
        status: synthesisRuns.status,
        error: synthesisRuns.error,
        startedAt: synthesisRuns.startedAt,
        completedAt: synthesisRuns.completedAt,
      })
      .from(synthesisRuns)
      .where(eq(synthesisRuns.id, runId))
      .limit(1);

    if (!run) {
      return NextResponse.json({ error: "Run not found." }, { status: 404 });
    }

    const counts =
      run.status === "completed" ? await countsForRun(run.id) : null;

    return NextResponse.json({
      runId: run.id,
      status: run.status,
      error: run.error,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      counts,
    });
  } catch (error) {
    console.error("GET /api/synthesis/status failed:", error);
    return NextResponse.json(
      { error: "Failed to load run status." },
      { status: 500 },
    );
  }
}
