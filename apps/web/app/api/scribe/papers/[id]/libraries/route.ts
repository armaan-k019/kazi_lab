import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, libraries, paperLibraries, papers } from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Link an existing paper to a library: POST { libraryId }.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: paperId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const libraryId =
    body && typeof body === "object" && "libraryId" in body
      ? (body as { libraryId: unknown }).libraryId
      : undefined;
  if (typeof libraryId !== "string" || libraryId.length === 0) {
    return NextResponse.json({ error: "libraryId is required." }, { status: 400 });
  }

  try {
    const [paper] = await db
      .select({ id: papers.id })
      .from(papers)
      .where(eq(papers.id, paperId))
      .limit(1);
    if (!paper) {
      return NextResponse.json({ error: "Paper not found." }, { status: 404 });
    }
    const [lib] = await db
      .select({ id: libraries.id })
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .limit(1);
    if (!lib) {
      return NextResponse.json({ error: "Library not found." }, { status: 404 });
    }

    await db
      .insert(paperLibraries)
      .values({ paperId, libraryId })
      .onConflictDoNothing();

    return NextResponse.json({ ok: true, paperId, libraryId });
  } catch (error) {
    console.error(
      `POST /api/scribe/papers/${paperId}/libraries failed:`,
      error,
    );
    return NextResponse.json(
      { error: "Failed to add the paper to the library." },
      { status: 500 },
    );
  }
}
