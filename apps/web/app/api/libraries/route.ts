import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db, libraries, paperLibraries } from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

// Create a library { name, description? }.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const name =
    body && typeof body === "object" && "name" in body
      ? (body as { name: unknown }).name
      : undefined;
  const description =
    body && typeof body === "object" && "description" in body
      ? (body as { description?: unknown }).description
      : undefined;

  if (typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json(
      { error: "A library name is required." },
      { status: 400 },
    );
  }

  try {
    const [created] = await db
      .insert(libraries)
      .values({
        name: name.trim(),
        description:
          typeof description === "string" && description.trim().length > 0
            ? description.trim()
            : null,
      })
      .returning();
    return NextResponse.json({ library: created }, { status: 201 });
  } catch (error) {
    console.error("POST /api/libraries failed:", error);
    return NextResponse.json(
      { error: "Failed to create the library." },
      { status: 500 },
    );
  }
}
