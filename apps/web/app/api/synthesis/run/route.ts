import { NextResponse } from "next/server";
import { createSynthesisRun, runSynthesis } from "@kazi-lab/scribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Belt-and-suspenders for serverless deploys; on the local Node server the
// fire-and-forget below completes on the event loop regardless.
export const maxDuration = 120;

// Start a synthesis run and return immediately. The run row is created
// synchronously (so we have a runId), then the slow Opus work runs in the
// background; the UI polls /api/synthesis/status for completion.
//
// NOTE: fire-and-forget is reliable here because kazi-lab runs on a long-lived
// Node server (next dev / next start), so the promise keeps executing after the
// response returns. On a frozen-after-response serverless platform this would
// need a queue/worker instead.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const libraryId =
    body && typeof body === "object" && "libraryId" in body
      ? (body as { libraryId: unknown }).libraryId
      : undefined;
  if (typeof libraryId !== "string" || libraryId.length === 0) {
    return NextResponse.json({ error: "libraryId is required." }, { status: 400 });
  }

  let runId: string;
  try {
    runId = await createSynthesisRun(libraryId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/at least 2 papers/i.test(message)) {
      return NextResponse.json(
        { error: "Synthesis needs at least 2 papers." },
        { status: 422 },
      );
    }
    if (/library not found/i.test(message)) {
      return NextResponse.json({ error: "Library not found." }, { status: 404 });
    }
    console.error("POST /api/synthesis/run failed:", error);
    return NextResponse.json(
      { error: "Could not start synthesis." },
      { status: 500 },
    );
  }

  // Fire-and-forget the heavy work. runSynthesis marks the run failed on error.
  void runSynthesis(runId).catch((error) => {
    console.error(`runSynthesis(${runId}) failed:`, error);
  });

  return NextResponse.json({ runId, status: "running" });
}
