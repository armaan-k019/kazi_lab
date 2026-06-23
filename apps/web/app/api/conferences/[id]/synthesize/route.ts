import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, libraryConferences } from "@kazi-lab/db";
import { synthesizeConferenceSource } from "@/lib/conference-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// (Re)synthesize a conference entry's source into themes/dates/scope. Non-fatal:
// failures are recorded on the row and returned, not thrown.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await synthesizeConferenceSource(id);
  const [conference] = await db
    .select()
    .from(libraryConferences)
    .where(eq(libraryConferences.id, id))
    .limit(1);
  return NextResponse.json({ result, conference: conference ?? null });
}
