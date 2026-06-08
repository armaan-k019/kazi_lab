import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { claims, db, papers } from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// List ingested papers with their claim counts, most-recent-ingested first.
export async function GET() {
  try {
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
      .leftJoin(claims, eq(claims.paperId, papers.id))
      .groupBy(papers.id)
      .orderBy(desc(papers.ingestedAt));

    return NextResponse.json({ papers: rows });
  } catch (error) {
    console.error("GET /api/scribe/papers failed:", error);
    return NextResponse.json(
      { error: "Failed to load the corpus." },
      { status: 500 },
    );
  }
}
