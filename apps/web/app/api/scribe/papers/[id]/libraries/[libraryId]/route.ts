import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, paperLibraries } from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Unlink a paper from a library. The paper persists in the corpus and in any
// other libraries it belongs to.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; libraryId: string }> },
) {
  const { id: paperId, libraryId } = await params;
  try {
    const removed = await db
      .delete(paperLibraries)
      .where(
        and(
          eq(paperLibraries.paperId, paperId),
          eq(paperLibraries.libraryId, libraryId),
        ),
      )
      .returning({ paperId: paperLibraries.paperId });

    if (removed.length === 0) {
      return NextResponse.json(
        { error: "That paper is not in that library." },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, paperId, libraryId });
  } catch (error) {
    console.error(
      `DELETE /api/scribe/papers/${paperId}/libraries/${libraryId} failed:`,
      error,
    );
    return NextResponse.json(
      { error: "Failed to unlink the paper." },
      { status: 500 },
    );
  }
}
