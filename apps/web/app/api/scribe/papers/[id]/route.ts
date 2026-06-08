import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import {
  authors,
  claims,
  db,
  extractions,
  paperAuthors,
  papers,
} from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Full detail for one paper: the paper, its extraction, claims, and ordered
// authors.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const [paper] = await db
      .select({
        id: papers.id,
        title: papers.title,
        arxivId: papers.arxivId,
        url: papers.url,
        pdfUrl: papers.pdfUrl,
        abstract: papers.abstract,
        publishedAt: papers.publishedAt,
        ingestedAt: papers.ingestedAt,
      })
      .from(papers)
      .where(eq(papers.id, id))
      .limit(1);

    if (!paper) {
      return NextResponse.json({ error: "Paper not found." }, { status: 404 });
    }

    const [extraction] = await db
      .select({
        extractionVersion: extractions.extractionVersion,
        problem: extractions.problem,
        priorWork: extractions.priorWork,
        method: extractions.method,
        results: extractions.results,
        limitations: extractions.limitations,
        keyTerms: extractions.keyTerms,
        datasetsUsed: extractions.datasetsUsed,
      })
      .from(extractions)
      .where(eq(extractions.paperId, id))
      .limit(1);

    const claimRows = await db
      .select({
        id: claims.id,
        text: claims.text,
        sourcePassage: claims.sourcePassage,
        confidence: claims.confidence,
      })
      .from(claims)
      .where(eq(claims.paperId, id))
      .orderBy(asc(claims.extractedAt));

    const authorRows = await db
      .select({ name: authors.name, position: paperAuthors.position })
      .from(paperAuthors)
      .innerJoin(authors, eq(authors.id, paperAuthors.authorId))
      .where(eq(paperAuthors.paperId, id))
      .orderBy(asc(paperAuthors.position));

    return NextResponse.json({
      paper,
      extraction: extraction ?? null,
      claims: claimRows,
      authors: authorRows,
    });
  } catch (error) {
    console.error(`GET /api/scribe/papers/${id} failed:`, error);
    return NextResponse.json(
      { error: "Failed to load this paper." },
      { status: 500 },
    );
  }
}

// Delete a paper entirely. FK cascades remove its extractions, claims,
// paper_authors, paper_libraries, and finding/relation links.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const deleted = await db
      .delete(papers)
      .where(eq(papers.id, id))
      .returning({ id: papers.id });
    if (deleted.length === 0) {
      return NextResponse.json({ error: "Paper not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, deletedId: id });
  } catch (error) {
    console.error(`DELETE /api/scribe/papers/${id} failed:`, error);
    return NextResponse.json(
      { error: "Failed to delete the paper." },
      { status: 500 },
    );
  }
}
