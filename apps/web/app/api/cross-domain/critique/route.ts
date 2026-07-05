import { NextResponse } from "next/server";
import { runCrossDomainCritique } from "@kazi-lab/lab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Two awaited Opus passes (validation + discovery). On the long-lived local Node
// server this completes within the request; a serverless deploy would queue it.
export const maxDuration = 300;

export async function POST(request: Request) {
  // Optional crossDomainRunId to audit a specific run; default is the latest.
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine; audit the latest completed cross-domain run.
  }
  const crossDomainRunId =
    body && typeof body === "object" && typeof (body as { crossDomainRunId?: unknown }).crossDomainRunId === "string"
      ? (body as { crossDomainRunId: string }).crossDomainRunId
      : undefined;

  try {
    const result = await runCrossDomainCritique(crossDomainRunId);
    if (result.status === "nothing") {
      return NextResponse.json({ error: result.reason }, { status: 422 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/cross-domain/critique failed:", error);
    return NextResponse.json(
      { error: "The cross-domain critique could not complete." },
      { status: 500 },
    );
  }
}
