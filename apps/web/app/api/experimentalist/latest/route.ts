import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import {
  db,
  experimentSpecs,
  experimentalistRuns,
  libraries,
  metaAnalyses,
  qualitativeEvidence,
} from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A full experiment run for the reading view: the claim, the computed pooled
// tables grouped by key, the qualitative evidence, the interpretation, and the
// spec. Defaults to the latest completed run; ?runId= selects a specific one.
export async function GET(request: Request) {
  try {
    const runId = new URL(request.url).searchParams.get("runId");
    const [run] = runId
      ? await db.select().from(experimentalistRuns).where(eq(experimentalistRuns.id, runId)).limit(1)
      : await db
          .select()
          .from(experimentalistRuns)
          .where(eq(experimentalistRuns.status, "completed"))
          .orderBy(desc(experimentalistRuns.completedAt))
          .limit(1);
    if (!run) return NextResponse.json({ run: null });

    const libRows = await db.select({ id: libraries.id, name: libraries.name }).from(libraries);
    const nameById = new Map(libRows.map((l) => [l.id, l.name]));

    const metaRows = await db.select().from(metaAnalyses).where(eq(metaAnalyses.runId, run.id));
    // Group by key; each key carries its pool kinds.
    const keyMap = new Map<
      string,
      {
        dataset: string | null;
        metric: string | null;
        task: string | null;
        conditions: string | null;
        nPapers: number | null;
        nMethods: number | null;
        kinds: Record<string, unknown>;
      }
    >();
    for (const m of metaRows) {
      const k = `${m.keyDataset}|${m.keyMetric}|${m.keyTask}|${m.keyConditions}`;
      const entry =
        keyMap.get(k) ??
        {
          dataset: m.keyDataset,
          metric: m.keyMetric,
          task: m.keyTask,
          conditions: m.keyConditions,
          nPapers: m.nPapers,
          nMethods: m.nMethods,
          kinds: {} as Record<string, unknown>,
        };
      entry.kinds[m.poolKind] = m.computed;
      keyMap.set(k, entry);
    }
    const metaKeys = [...keyMap.values()].sort((a, b) => (b.nPapers ?? 0) - (a.nPapers ?? 0));

    const qualRows = await db.select().from(qualitativeEvidence).where(eq(qualitativeEvidence.runId, run.id));
    const qualByLib = new Map<string, { libraryName: string; findings: { findingRef: string | null; excerpt: string | null; note: string | null }[] }>();
    for (const q of qualRows) {
      const name = nameById.get(q.libraryId) ?? "library";
      const entry = qualByLib.get(q.libraryId) ?? { libraryName: name, findings: [] };
      entry.findings.push({ findingRef: q.findingRef, excerpt: q.excerpt, note: q.relevanceNote });
      qualByLib.set(q.libraryId, entry);
    }

    const [spec] = await db.select().from(experimentSpecs).where(eq(experimentSpecs.runId, run.id));

    return NextResponse.json({
      run: {
        id: run.id,
        inputKind: run.inputKind,
        claim: run.claim,
        scope: run.scopeLibraryIds.map((id) => nameById.get(id) ?? "unknown"),
        status: run.status,
        notes: run.notes,
        completedAt: run.completedAt,
        interpretation: run.interpretation,
      },
      metaKeys,
      qualitative: [...qualByLib.values()],
      spec: spec ?? null,
    });
  } catch (error) {
    console.error("GET /api/experimentalist/latest failed:", error);
    return NextResponse.json({ error: "Failed to load the experiment run." }, { status: 500 });
  }
}
