import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, libraryConferences } from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function optText(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

// Edit a conference entry. Changing the source resets it to unsynthesized so a
// stale synthesis is not shown against a new source.
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
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if ("name" in obj) {
      const name = typeof obj.name === "string" ? obj.name.trim() : "";
      if (!name) return NextResponse.json({ error: "Name cannot be empty." }, { status: 400 });
      set.name = name;
    }
    let sourceChanged = false;
    if ("sourceKind" in obj) {
      set.sourceKind =
        obj.sourceKind === "url" || obj.sourceKind === "pdf" || obj.sourceKind === "text"
          ? obj.sourceKind
          : "none";
      sourceChanged = true;
    }
    if ("sourceUrl" in obj) {
      set.sourceUrl = optText(obj, "sourceUrl");
      sourceChanged = true;
    }
    if ("rawSourceText" in obj) {
      set.rawSourceText = optText(obj, "rawSourceText");
      sourceChanged = true;
    }
    if ("notes" in obj) set.notes = optText(obj, "notes");
    if (sourceChanged) {
      set.synthStatus = "none";
      set.themes = [];
      set.keyDates = [];
      set.scopeSummary = null;
    }

    const [updated] = await db
      .update(libraryConferences)
      .set(set)
      .where(eq(libraryConferences.id, id))
      .returning();
    if (!updated) {
      return NextResponse.json({ error: "Conference not found." }, { status: 404 });
    }
    return NextResponse.json({ conference: updated });
  } catch (error) {
    console.error(`PATCH /api/conferences/${id} failed:`, error);
    return NextResponse.json(
      { error: "Failed to update the conference." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await db.delete(libraryConferences).where(eq(libraryConferences.id, id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(`DELETE /api/conferences/${id} failed:`, error);
    return NextResponse.json(
      { error: "Failed to remove the conference." },
      { status: 500 },
    );
  }
}
