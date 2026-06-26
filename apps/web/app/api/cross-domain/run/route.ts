import { NextResponse } from "next/server";
import { runCrossDomainSynthesis } from "@kazi-lab/lab";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The Opus cross-domain reasoning is awaited here. On the long-lived local Node
// server this completes within the request; a serverless deploy would queue it.
export const maxDuration = 300;

export async function POST(request: Request) {
  // Optional libraryIds to restrict the scope; default is all eligible.
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine; run over all eligible libraries.
  }
  const libraryIds =
    body && typeof body === "object" && Array.isArray((body as { libraryIds?: unknown }).libraryIds)
      ? ((body as { libraryIds: unknown[] }).libraryIds.filter(
          (x): x is string => typeof x === "string",
        ))
      : undefined;

  try {
    const result = await runCrossDomainSynthesis(libraryIds);
    if (result.status === "insufficient") {
      return NextResponse.json({ error: result.reason, ...result }, { status: 422 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/cross-domain/run failed:", error);
    return NextResponse.json(
      { error: "The cross-domain synthesis could not complete." },
      { status: 500 },
    );
  }
}
