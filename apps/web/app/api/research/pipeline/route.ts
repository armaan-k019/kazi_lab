import { NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  criticRuns,
  db,
  experimentalistRuns,
  researchDocuments,
  writerRuns,
} from "@kazi-lab/db";
// THE detection logic, imported from the scheduler, never reimplemented: the
// pipeline strip and the scheduler can never disagree about stale/missing.
import { buildCorpusSnapshot, detectStaleStates } from "@kazi-lab/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type PipelineStageState = "done" | "stale" | "missing" | "none_found";

// Per-library pipeline state for the Research primary region and the
// Libraries panel glance. Synthesis/metrics/cross-domain states come straight
// from detectStaleStates; critic/experiment/document stages have no detection
// rules yet, so this route reports plain presence and age (no invented rules).
export async function GET() {
  try {
    const now = new Date();
    const snapshot = await buildCorpusSnapshot(now);
    const detection = detectStaleStates(snapshot);

    const staleSynthLibs = new Set(detection.tasks.filter((t) => t.kind === "re_synthesize").flatMap((t) => t.scope));
    const missingMetricLibs = new Set(detection.tasks.filter((t) => t.kind === "extract_metrics").flatMap((t) => t.scope));
    const crossDomainLibs = new Set(detection.tasks.filter((t) => t.kind === "extract_cross_domain").flatMap((t) => t.scope));
    const cleanZeroScanLibs = new Set(
      detection.diagnostics
        .filter((d) => d.kind === "missing_metrics" && d.details.scanned === true)
        .map((d) => d.affectedLibraryId)
        .filter((x): x is string => x !== null),
    );

    const libIds = snapshot.libraries.map((l) => l.id);

    // Latest completed critic run per library.
    const criticRows = libIds.length
      ? await db
          .select({ libraryId: criticRuns.libraryId, completedAt: criticRuns.completedAt })
          .from(criticRuns)
          .where(and(eq(criticRuns.status, "completed"), inArray(criticRuns.libraryId, libIds)))
          .orderBy(desc(criticRuns.completedAt))
      : [];
    const latestCriticBy = new Map<string, Date>();
    for (const r of criticRows) {
      if (r.completedAt && !latestCriticBy.has(r.libraryId)) latestCriticBy.set(r.libraryId, r.completedAt);
    }

    // Latest completed experimentalist run touching each library, and whether
    // a research document exists downstream of any of them.
    const expRows = await db
      .select({ id: experimentalistRuns.id, scope: experimentalistRuns.scopeLibraryIds, completedAt: experimentalistRuns.completedAt })
      .from(experimentalistRuns)
      .where(eq(experimentalistRuns.status, "completed"))
      .orderBy(desc(experimentalistRuns.completedAt));
    const latestExpBy = new Map<string, { at: Date; runId: string }>();
    for (const r of expRows) {
      if (!r.completedAt) continue;
      for (const libId of r.scope) {
        if (!latestExpBy.has(libId)) latestExpBy.set(libId, { at: r.completedAt, runId: r.id });
      }
    }
    const expRunIds = expRows.map((r) => r.id);
    const docRows = expRunIds.length
      ? await db
          .select({ expRunId: writerRuns.experimentalistRunId, completedAt: writerRuns.completedAt, docId: researchDocuments.id })
          .from(writerRuns)
          .innerJoin(researchDocuments, eq(researchDocuments.writerRunId, writerRuns.id))
          .where(and(eq(writerRuns.status, "completed"), inArray(writerRuns.experimentalistRunId, expRunIds)))
      : [];
    const docByExpRun = new Map<string, Date | null>();
    for (const d of docRows) if (!docByExpRun.has(d.expRunId)) docByExpRun.set(d.expRunId, d.completedAt);

    const libraries = snapshot.libraries.map((l) => {
      const criticAt = latestCriticBy.get(l.id) ?? null;
      const exp = latestExpBy.get(l.id) ?? null;
      const docAt = exp ? (docByExpRun.get(exp.runId) ?? null) : null;
      const synthesisState: PipelineStageState =
        l.latestSynthesisAt === null ? "missing" : staleSynthLibs.has(l.id) ? "stale" : "done";
      const metricsState: PipelineStageState =
        l.metricRowCount > 0 ? "done" : cleanZeroScanLibs.has(l.id) ? "none_found" : missingMetricLibs.has(l.id) || l.papersWithKeyTerms > 0 ? "missing" : "missing";
      const criticState: PipelineStageState =
        criticAt === null
          ? l.latestSynthesisAt === null
            ? "missing"
            : "missing"
          : l.latestSynthesisAt !== null && criticAt < l.latestSynthesisAt
            ? "stale"
            : "done";
      const crossDomainState: PipelineStageState =
        l.latestSynthesisAt === null ? "missing" : crossDomainLibs.has(l.id) ? "stale" : "done";
      return {
        id: l.id,
        name: l.name,
        isAllPapers: l.isAllPapers,
        paperCount: l.paperCount,
        stages: {
          papers: { state: (l.paperCount > 0 ? "done" : "missing") as PipelineStageState, count: l.paperCount },
          synthesis: { state: synthesisState, at: l.latestSynthesisAt },
          critic: { state: criticState, at: criticAt },
          metrics: { state: metricsState, rows: l.metricRowCount },
          crossDomain: { state: crossDomainState, at: snapshot.latestCrossDomain?.completedAt ?? null },
          experiment: { state: (exp ? "done" : "missing") as PipelineStageState, at: exp?.at ?? null },
          document: { state: (docAt !== null ? "done" : "missing") as PipelineStageState, at: docAt },
        },
      };
    });

    // Critic panel badge: synthesized libraries whose audit is absent or
    // predates the latest synthesis.
    const unauditedSyntheses = libraries.filter((l) => !l.isAllPapers && l.stages.synthesis.state !== "missing" && l.stages.critic.state !== "done").length;

    return NextResponse.json({ libraries, unauditedSyntheses, stats: detection.stats });
  } catch (error) {
    console.error("GET /api/research/pipeline failed:", error);
    return NextResponse.json({ error: "Failed to derive the pipeline state." }, { status: 500 });
  }
}
