import { NextResponse } from "next/server";
import { buildCorpusSnapshot, detectStaleStates, scheduleApprovableRun } from "@kazi-lab/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Run one detection pass now and persist it as an immutable scheduler run.
// Detection is deterministic TypeScript; no LLM call happens here.
export async function POST(request: Request) {
  let thresholdDays = 30;
  try {
    const body = (await request.json()) as { thresholdDays?: number };
    if (typeof body.thresholdDays === "number" && body.thresholdDays > 0) thresholdDays = body.thresholdDays;
  } catch {
    // Empty body: default threshold.
  }
  try {
    const passStart = new Date();
    const snapshot = await buildCorpusSnapshot(passStart);
    const detection = detectStaleStates(snapshot, thresholdDays);
    const summary = await scheduleApprovableRun(detection, passStart, new Date());
    return NextResponse.json(summary);
  } catch (error) {
    console.error("POST /api/scheduler/detect failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Detection failed: ${message}` }, { status: 500 });
  }
}
