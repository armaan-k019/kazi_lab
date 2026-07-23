import { NextResponse } from "next/server";
import { proposeCrossovers } from "@kazi-lab/web-graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One proposer LLM call, grounding, and (default) an auto-audit by the existing
// cross-domain Critic. Awaited here on the long-lived local Node server.
export const maxDuration = 300;

export async function POST(request: Request) {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Empty body: propose from the latest completed web build, auto-audit on.
  }
  const webRunId =
    body && typeof body === "object" && typeof (body as { webRunId?: unknown }).webRunId === "string"
      ? (body as { webRunId: string }).webRunId
      : undefined;

  try {
    const result = await proposeCrossovers(webRunId);
    // All three shapes carry diagnostics; the client renders the real reason and
    // the stage-by-stage pipeline, never an opaque message.
    if (result.status === "nothing") {
      return NextResponse.json({ error: result.reason, diagnostics: result.diagnostics }, { status: 422 });
    }
    if (result.status === "failed") {
      return NextResponse.json({ error: result.reason, stage: result.stage, diagnostics: result.diagnostics }, { status: 500 });
    }
    return NextResponse.json(result);
  } catch (error) {
    // Should not happen (every stage is guarded), but if it does, surface the
    // real message rather than an opaque abort.
    console.error("POST /api/web/propose failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `The proposal run failed unexpectedly: ${message}` }, { status: 500 });
  }
}
