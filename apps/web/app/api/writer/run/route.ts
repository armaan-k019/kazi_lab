import { NextResponse } from "next/server";
import { runWriter } from "@kazi-lab/writer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One awaited Opus call produces the document. On the long-lived local Node
// server this completes in the request; a serverless deploy would queue it.
export const maxDuration = 300;

export async function POST(request: Request) {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine; document the latest completed Experimentalist run.
  }
  const experimentalistRunId =
    body && typeof body === "object" && typeof (body as { experimentalistRunId?: unknown }).experimentalistRunId === "string"
      ? (body as { experimentalistRunId: string }).experimentalistRunId
      : undefined;

  try {
    const result = await runWriter(experimentalistRunId);
    if (result.status === "nothing") {
      return NextResponse.json({ error: result.reason }, { status: 422 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/writer/run failed:", error);
    return NextResponse.json({ error: "The document could not be written." }, { status: 500 });
  }
}
