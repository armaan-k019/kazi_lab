import { NextResponse } from "next/server";
import { findLibraryGaps } from "@kazi-lab/scribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "What am I missing": scan the active library's citation graph for works that
// connect to multiple library papers. Several live OpenAlex calls, so this can
// take a few seconds.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const libraryId = searchParams.get("libraryId") ?? "";
  if (!libraryId) {
    return NextResponse.json(
      { error: "libraryId is required." },
      { status: 400 },
    );
  }
  try {
    const result = await findLibraryGaps(libraryId);
    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/external/gaps failed:", error);
    return NextResponse.json(
      { error: "Could not scan the citation graph (OpenAlex error)." },
      { status: 502 },
    );
  }
}
