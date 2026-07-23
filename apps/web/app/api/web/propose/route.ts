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
    if (result.status === "nothing") {
      return NextResponse.json({ error: result.reason }, { status: 422 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/web/propose failed:", error);
    return NextResponse.json({ error: "The proposal run could not complete." }, { status: 500 });
  }
}
