import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, libraries, libraryConferences } from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function optText(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

// Add a conference entry to a library. Synthesis of its source is a separate
// action (POST /api/conferences/[id]/synthesize).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "A conference name is required." }, { status: 400 });
  }
  const sourceKind =
    obj.sourceKind === "url" || obj.sourceKind === "pdf" || obj.sourceKind === "text"
      ? obj.sourceKind
      : "none";

  try {
    const [lib] = await db
      .select({ id: libraries.id })
      .from(libraries)
      .where(eq(libraries.id, id))
      .limit(1);
    if (!lib) {
      return NextResponse.json({ error: "Library not found." }, { status: 404 });
    }
    const [created] = await db
      .insert(libraryConferences)
      .values({
        libraryId: id,
        name,
        sourceKind,
        sourceUrl: optText(obj, "sourceUrl"),
        rawSourceText: optText(obj, "rawSourceText"),
        notes: optText(obj, "notes"),
      })
      .returning();
    return NextResponse.json({ conference: created }, { status: 201 });
  } catch (error) {
    console.error(`POST /api/libraries/${id}/conferences failed:`, error);
    return NextResponse.json(
      { error: "Failed to add the conference." },
      { status: 500 },
    );
  }
}
