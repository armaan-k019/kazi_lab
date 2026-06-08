import { NextResponse } from "next/server";
import { getAuthorWorks, shapeCandidates } from "@kazi-lab/scribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLICE = 15; // curated slice of an author's most-cited works

// An author's top other works, as ingestable discovery candidates. Live
// OpenAlex lookup, no storage.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const authorId = searchParams.get("authorId") ?? "";
  const libraryId = searchParams.get("libraryId") ?? "";
  if (!authorId || !libraryId) {
    return NextResponse.json(
      { error: "authorId and libraryId are required." },
      { status: 400 },
    );
  }

  try {
    const works = await getAuthorWorks(authorId, SLICE);
    const candidates = await shapeCandidates(works, libraryId);
    return NextResponse.json({ works: candidates });
  } catch (error) {
    console.error("GET /api/external/author-works failed:", error);
    return NextResponse.json(
      { error: "Could not load author works from OpenAlex." },
      { status: 502 },
    );
  }
}
