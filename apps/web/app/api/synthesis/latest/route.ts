import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db, synthesisRuns } from "@kazi-lab/db";
import { countsForRun } from "@/lib/synthesis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The most recent COMPLETED synthesis run for a library (or null), with counts.
export async function GET(request: Request) {
  const libraryId = new URL(request.url).searchParams.get("libraryId");
  if (!libraryId) {
    return NextResponse.json({ error: "libraryId is required." }, { status: 400 });
  }

  try {
    const [run] = await db
      .select({
        id: synthesisRuns.id,
        completedAt: synthesisRuns.completedAt,
      })
      .from(synthesisRuns)
      .where(
        and(
          eq(synthesisRuns.libraryId, libraryId),
          eq(synthesisRuns.status, "completed"),
        ),
      )
      .orderBy(desc(synthesisRuns.completedAt))
      .limit(1);

    if (!run) {
      return NextResponse.json({ latest: null });
    }

    const counts = await countsForRun(run.id);
    return NextResponse.json({
      latest: { runId: run.id, completedAt: run.completedAt, ...counts },
    });
  } catch (error) {
    console.error("GET /api/synthesis/latest failed:", error);
    return NextResponse.json(
      { error: "Failed to load latest synthesis." },
      { status: 500 },
    );
  }
}
