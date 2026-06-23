import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db, libraries, libraryConferences, paperLibraries } from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read an optional trimmed string field, or null.
function optText(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

// List libraries with paper counts. "general" first, then newest.
export async function GET() {
  try {
    const rows = await db
      .select({
        id: libraries.id,
        name: libraries.name,
        description: libraries.description,
        createdAt: libraries.createdAt,
        paperCount: sql<number>`count(${paperLibraries.paperId})::int`,
      })
      .from(libraries)
      .leftJoin(paperLibraries, eq(paperLibraries.libraryId, libraries.id))
      .groupBy(libraries.id)
      .orderBy(sql`(${libraries.name} = 'general') desc`, desc(libraries.createdAt));

    return NextResponse.json({ libraries: rows });
  } catch (error) {
    console.error("GET /api/libraries failed:", error);
    return NextResponse.json(
      { error: "Failed to load libraries." },
      { status: 500 },
    );
  }
}

// Create a library. Only name is required; all research-context fields and the
// conferences array are optional, so create-with-only-a-name still works.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (name.length === 0) {
    return NextResponse.json(
      { error: "A library name is required." },
      { status: 400 },
    );
  }

  try {
    const [created] = await db
      .insert(libraries)
      .values({
        name,
        description: optText(obj, "description"),
        researchFocus: optText(obj, "researchFocus"),
        hypothesis: optText(obj, "hypothesis"),
        userNotes: optText(obj, "userNotes"),
        targetVenueType: optText(obj, "targetVenueType"),
        status: optText(obj, "status"),
      })
      .returning({ id: libraries.id });

    // Optional conferences: insert any with a name (synthesis is a separate
    // action). Conference sources are venue context, never papers.
    const confs = Array.isArray(obj.conferences) ? obj.conferences : [];
    for (const raw of confs) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as Record<string, unknown>;
      const cname = typeof c.name === "string" ? c.name.trim() : "";
      if (!cname) continue;
      const sourceKind =
        c.sourceKind === "url" || c.sourceKind === "pdf" || c.sourceKind === "text"
          ? c.sourceKind
          : "none";
      await db.insert(libraryConferences).values({
        libraryId: created.id,
        name: cname,
        sourceKind,
        sourceUrl: optText(c, "sourceUrl"),
        rawSourceText: optText(c, "rawSourceText"),
        notes: optText(c, "notes"),
      });
    }

    return NextResponse.json({ library: created }, { status: 201 });
  } catch (error) {
    console.error("POST /api/libraries failed:", error);
    return NextResponse.json(
      { error: "Failed to create the library." },
      { status: 500 },
    );
  }
}
