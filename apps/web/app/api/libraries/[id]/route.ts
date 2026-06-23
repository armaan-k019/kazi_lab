import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db, libraries, libraryConferences } from "@kazi-lab/db";
import { isAllPapersLibrary } from "@/lib/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function optText(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

// Library detail: the research-context fields plus its conferences (with any
// synthesized context). user_notes is included for display only.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const [lib] = await db
      .select()
      .from(libraries)
      .where(eq(libraries.id, id))
      .limit(1);
    if (!lib) {
      return NextResponse.json({ error: "Library not found." }, { status: 404 });
    }
    const conferences = await db
      .select()
      .from(libraryConferences)
      .where(eq(libraryConferences.libraryId, id))
      .orderBy(asc(libraryConferences.createdAt));
    return NextResponse.json({ library: { ...lib, conferences } });
  } catch (error) {
    console.error(`GET /api/libraries/${id} failed:`, error);
    return NextResponse.json(
      { error: "Failed to load the library." },
      { status: 500 },
    );
  }
}

// Update a library's optional research-context fields (and name/description).
// The general library cannot be renamed away from "general".
export async function PATCH(
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

  try {
    const [lib] = await db
      .select({ name: libraries.name })
      .from(libraries)
      .where(eq(libraries.id, id))
      .limit(1);
    if (!lib) {
      return NextResponse.json({ error: "Library not found." }, { status: 404 });
    }

    const set: Record<string, string | null | Date> = { updatedAt: new Date() };
    if ("name" in obj) {
      const newName = typeof obj.name === "string" ? obj.name.trim() : "";
      if (!newName) {
        return NextResponse.json({ error: "Name cannot be empty." }, { status: 400 });
      }
      if (isAllPapersLibrary(lib.name) && !isAllPapersLibrary(newName)) {
        return NextResponse.json(
          { error: "The general library cannot be renamed." },
          { status: 403 },
        );
      }
      set.name = newName;
    }
    for (const key of [
      "description",
      "researchFocus",
      "hypothesis",
      "userNotes",
      "targetVenueType",
      "status",
    ]) {
      if (key in obj) set[key] = optText(obj, key);
    }

    const [updated] = await db
      .update(libraries)
      .set(set)
      .where(eq(libraries.id, id))
      .returning({ id: libraries.id });
    return NextResponse.json({ library: updated });
  } catch (error) {
    console.error(`PATCH /api/libraries/${id} failed:`, error);
    return NextResponse.json(
      { error: "Failed to update the library." },
      { status: 500 },
    );
  }
}

// Delete a library. The FK cascade removes its paper_libraries links only; the
// papers themselves persist. "general" is undeletable.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const [lib] = await db
      .select({ id: libraries.id, name: libraries.name })
      .from(libraries)
      .where(eq(libraries.id, id))
      .limit(1);

    if (!lib) {
      return NextResponse.json({ error: "Library not found." }, { status: 404 });
    }
    if (isAllPapersLibrary(lib.name)) {
      return NextResponse.json(
        { error: "The 'general' library cannot be deleted." },
        { status: 403 },
      );
    }

    await db.delete(libraries).where(eq(libraries.id, id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(`DELETE /api/libraries/${id} failed:`, error);
    return NextResponse.json(
      { error: "Failed to delete the library." },
      { status: 500 },
    );
  }
}
