import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, paperExternal } from "@kazi-lab/db";
import {
  getWork,
  getWorksByIds,
  getCitingWorks,
  shapeCandidates,
} from "@kazi-lab/scribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLICE = 12; // curated slice size for references and citing works

// Citation context for a matched paper: its authors, top references it builds
// on, and the most-cited works that cite it. Live OpenAlex lookups, no storage.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const paperId = searchParams.get("paperId") ?? "";
  const libraryId = searchParams.get("libraryId") ?? "";
  if (!paperId || !libraryId) {
    return NextResponse.json(
      { error: "paperId and libraryId are required." },
      { status: 400 },
    );
  }

  try {
    const [ext] = await db
      .select({ openalexId: paperExternal.openalexId })
      .from(paperExternal)
      .where(
        and(
          eq(paperExternal.paperId, paperId),
          eq(paperExternal.source, "openalex"),
          eq(paperExternal.matchStatus, "matched"),
        ),
      )
      .limit(1);

    if (!ext?.openalexId) {
      return NextResponse.json({ available: false });
    }

    const work = await getWork(ext.openalexId);
    if (!work) {
      return NextResponse.json({ available: false });
    }

    // References: resolve the cited OpenAlex ids to metadata, then take the
    // top slice by citation count.
    const referenced =
      work.referencedWorkIds.length > 0
        ? await getWorksByIds(work.referencedWorkIds)
        : [];
    referenced.sort((a, b) => (b.citedByCount ?? 0) - (a.citedByCount ?? 0));
    const buildsOn = await shapeCandidates(
      referenced.slice(0, SLICE),
      libraryId,
    );

    const citing = await getCitingWorks(ext.openalexId, SLICE);
    const citedBy = await shapeCandidates(citing, libraryId);

    return NextResponse.json({
      available: true,
      authors: work.authors,
      buildsOn,
      citedBy,
    });
  } catch (error) {
    console.error("GET /api/external/paper-context failed:", error);
    return NextResponse.json(
      { error: "Could not load external context from OpenAlex." },
      { status: 502 },
    );
  }
}
