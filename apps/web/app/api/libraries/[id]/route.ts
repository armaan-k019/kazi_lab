import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, libraries } from "@kazi-lab/db";
import { isAllPapersLibrary } from "@/lib/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
