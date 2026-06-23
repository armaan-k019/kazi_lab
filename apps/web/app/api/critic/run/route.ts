import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, libraries } from "@kazi-lab/db";
import { runCritique } from "@kazi-lab/critic";
import { isAllPapersLibrary } from "@/lib/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The Opus critique is awaited here. On the long-lived local Node server this
// completes within the request; a serverless deploy would want a queue/worker.
export const maxDuration = 300;

export async function POST(request: Request) {
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

  const [lib] = await db
    .select({ name: libraries.name })
    .from(libraries)
    .where(eq(libraries.id, libraryId))
    .limit(1);
  if (!lib) {
    return NextResponse.json({ error: "Library not found." }, { status: 404 });
  }
  // The general library is an all-papers view, not a synthesizable research
  // library, so it is not critiqued either.
  if (isAllPapersLibrary(lib.name)) {
    return NextResponse.json(
      { error: "The general library is an all-papers view and is not critiqued." },
      { status: 422 },
    );
  }

  try {
    const result = await runCritique(libraryId);
    if (result.status === "nothing") {
      return NextResponse.json({ error: result.reason }, { status: 422 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/critic/run failed:", error);
    return NextResponse.json(
      { error: "The critique could not complete." },
      { status: 500 },
    );
  }
}
