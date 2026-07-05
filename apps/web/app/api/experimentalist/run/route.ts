import { NextResponse } from "next/server";
import { runExperiment } from "@kazi-lab/experimentalist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Deterministic pooling is instant; the two awaited Opus calls (interpretation +
// spec design) dominate. On the long-lived local Node server this completes in
// the request; a serverless deploy would queue it.
export const maxDuration = 300;

const KINDS = new Set(["abstract", "cross_domain_link", "library"]);

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  const inputKind = typeof obj.inputKind === "string" ? obj.inputKind : "";
  const inputRef = typeof obj.inputRef === "string" ? obj.inputRef : "";
  if (!KINDS.has(inputKind) || !inputRef) {
    return NextResponse.json(
      { error: "inputKind (abstract | cross_domain_link | library) and inputRef are required." },
      { status: 400 },
    );
  }

  try {
    const result = await runExperiment(inputKind as "abstract" | "cross_domain_link" | "library", inputRef);
    if (result.status === "failed_precondition") {
      return NextResponse.json({ error: result.reason }, { status: 422 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/experimentalist/run failed:", error);
    return NextResponse.json(
      { error: "The experiment could not complete." },
      { status: 500 },
    );
  }
}
