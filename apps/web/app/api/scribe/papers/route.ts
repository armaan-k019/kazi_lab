import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { claims, db, libraries, paperLibraries, papers } from "@kazi-lab/db";
import { GENERAL_LIBRARY_NAME } from "@/lib/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Resolve the library to scope by: the given id, or the "general" library.
async function resolveLibraryId(libraryId: string | null): Promise<string | null> {
  if (libraryId) return libraryId;
  const [general] = await db
    .select({ id: libraries.id })
    .from(libraries)
    .where(eq(libraries.name, GENERAL_LIBRARY_NAME))
    .limit(1);
  return general?.id ?? null;
}

// List papers in a library with their claim counts, most-recent-ingested first.
// Without ?libraryId, defaults to the "general" library.
export async function GET(request: Request) {
  try {
    const requested = new URL(request.url).searchParams.get("libraryId");
    const libraryId = await resolveLibraryId(requested);
    if (!libraryId) {
      // No library at all yet: empty corpus.
      return NextResponse.json({ papers: [], libraryId: null });
    }

    const rows = await db
      .select({
        id: papers.id,
        title: papers.title,
        authors: papers.authors,
        arxivId: papers.arxivId,
        url: papers.url,
        publishedAt: papers.publishedAt,
        ingestedAt: papers.ingestedAt,
        claimCount: sql<number>`count(${claims.id})::int`,
      })
      .from(papers)
      .innerJoin(
        paperLibraries,
        and(
          eq(paperLibraries.paperId, papers.id),
          eq(paperLibraries.libraryId, libraryId),
        ),
      )
      .leftJoin(claims, eq(claims.paperId, papers.id))
      .groupBy(papers.id)
      .orderBy(desc(papers.ingestedAt));

    return NextResponse.json({ papers: rows, libraryId });
  } catch (error) {
    console.error("GET /api/scribe/papers failed:", error);
    return NextResponse.json(
      { error: "Failed to load the corpus." },
      { status: 500 },
    );
  }
}
