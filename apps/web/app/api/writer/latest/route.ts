import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import {
  db,
  experimentalistRuns,
  researchDocuments,
  writerRuns,
} from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Writer view payload: the pickable completed Experimentalist runs (with
// whether each already has a document) plus one rendered document. Defaults to
// the latest completed writer run; ?writerRunId= or ?experimentalistRunId=
// select a specific one.
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const writerRunId = url.searchParams.get("writerRunId");
    const expRunId = url.searchParams.get("experimentalistRunId");

    // Picker: completed Experimentalist runs, newest first.
    const expRuns = await db
      .select({ id: experimentalistRuns.id, claim: experimentalistRuns.claim, completedAt: experimentalistRuns.completedAt })
      .from(experimentalistRuns)
      .where(eq(experimentalistRuns.status, "completed"))
      .orderBy(desc(experimentalistRuns.completedAt));
    // Which have a completed writer document.
    const docRuns = await db
      .select({ experimentalistRunId: writerRuns.experimentalistRunId })
      .from(writerRuns)
      .where(eq(writerRuns.status, "completed"));
    const documented = new Set(docRuns.map((d) => d.experimentalistRunId));
    const picker = expRuns.map((r) => ({
      id: r.id,
      claim: r.claim,
      completedAt: r.completedAt,
      hasDocument: documented.has(r.id),
    }));

    // Resolve the writer run to show.
    const [wRun] = writerRunId
      ? await db.select().from(writerRuns).where(eq(writerRuns.id, writerRunId)).limit(1)
      : expRunId
        ? await db
            .select()
            .from(writerRuns)
            .where(eq(writerRuns.experimentalistRunId, expRunId))
            .orderBy(desc(writerRuns.completedAt))
            .limit(1)
        : await db
            .select()
            .from(writerRuns)
            .where(eq(writerRuns.status, "completed"))
            .orderBy(desc(writerRuns.completedAt))
            .limit(1);

    if (!wRun) {
      return NextResponse.json({ experimentalistRuns: picker, document: null });
    }
    const [doc] = await db.select().from(researchDocuments).where(eq(researchDocuments.writerRunId, wRun.id)).limit(1);
    const [expRun] = await db
      .select({ claim: experimentalistRuns.claim })
      .from(experimentalistRuns)
      .where(eq(experimentalistRuns.id, wRun.experimentalistRunId))
      .limit(1);

    return NextResponse.json({
      experimentalistRuns: picker,
      document: doc
        ? {
            writerRunId: wRun.id,
            experimentalistRunId: wRun.experimentalistRunId,
            claim: expRun?.claim ?? null,
            title: doc.title,
            sections: doc.sections,
            provenance: doc.provenance,
            conferencesConsidered: doc.conferencesConsidered,
            notes: wRun.notes,
            completedAt: wRun.completedAt,
          }
        : null,
    });
  } catch (error) {
    console.error("GET /api/writer/latest failed:", error);
    return NextResponse.json({ error: "Failed to load the document." }, { status: 500 });
  }
}
