import { NextResponse } from "next/server";
import { buildWeb } from "@kazi-lab/web-graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Deterministic graph construction plus one small labeling call and the concept
// embedding batch. On the long-lived local Node server this completes in the
// request; a serverless deploy would queue it.
export const maxDuration = 300;

export async function POST() {
  try {
    const result = await buildWeb();
    if (result.status === "empty") {
      return NextResponse.json({ error: result.reason }, { status: 422 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/web/build failed:", error);
    return NextResponse.json({ error: "The web build could not complete." }, { status: 500 });
  }
}
