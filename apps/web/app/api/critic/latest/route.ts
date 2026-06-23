import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  claims,
  claimRelations,
  contradictionVerdicts,
  criticRuns,
  db,
  findings,
  findingVerdicts,
  libraries,
  papers,
  synthesisRuns,
} from "@kazi-lab/db";
import { isAllPapersLibrary } from "@/lib/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Latest completed critic run for a library, with verdicts joined to the exact
// relations/findings they judged for display. Reports general and no-synthesis
// states so the UI can show the right calm message.
export async function GET(request: Request) {
  const libraryId = new URL(request.url).searchParams.get("libraryId");
  if (!libraryId) {
    return NextResponse.json({ error: "libraryId is required." }, { status: 400 });
  }

  try {
    const [lib] = await db
      .select({ name: libraries.name })
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .limit(1);
    if (!lib) {
      return NextResponse.json({ error: "Library not found." }, { status: 404 });
    }
    if (isAllPapersLibrary(lib.name)) {
      return NextResponse.json({ general: true });
    }

    const [synth] = await db
      .select({ id: synthesisRuns.id })
      .from(synthesisRuns)
      .where(
        and(
          eq(synthesisRuns.libraryId, libraryId),
          eq(synthesisRuns.status, "completed"),
        ),
      )
      .orderBy(desc(synthesisRuns.completedAt))
      .limit(1);
    const hasSynthesis = !!synth;

    const [run] = await db
      .select({
        id: criticRuns.id,
        createdAt: criticRuns.createdAt,
        completedAt: criticRuns.completedAt,
        notes: criticRuns.notes,
      })
      .from(criticRuns)
      .where(
        and(
          eq(criticRuns.libraryId, libraryId),
          eq(criticRuns.status, "completed"),
        ),
      )
      .orderBy(desc(criticRuns.completedAt))
      .limit(1);

    if (!run) {
      return NextResponse.json({
        general: false,
        hasSynthesis,
        run: null,
        contradictions: [],
        findings: [],
      });
    }

    // Contradiction verdicts, resolved to claim texts + papers + synthesis note.
    const cvRows = await db
      .select({
        id: contradictionVerdicts.id,
        claimRelationId: contradictionVerdicts.claimRelationId,
        verdict: contradictionVerdicts.verdict,
        rationale: contradictionVerdicts.rationale,
        confidence: contradictionVerdicts.confidence,
        severity: contradictionVerdicts.severity,
      })
      .from(contradictionVerdicts)
      .where(eq(contradictionVerdicts.criticRunId, run.id));

    const relIds = cvRows.map((c) => c.claimRelationId);
    const relRows = relIds.length
      ? await db
          .select({
            id: claimRelations.id,
            rationale: claimRelations.rationale,
            fromClaimId: claimRelations.fromClaimId,
            toClaimId: claimRelations.toClaimId,
          })
          .from(claimRelations)
          .where(inArray(claimRelations.id, relIds))
      : [];
    const relById = new Map(relRows.map((r) => [r.id, r]));
    const claimIds = relRows.flatMap((r) => [r.fromClaimId, r.toClaimId]);
    const claimRows = claimIds.length
      ? await db
          .select({ id: claims.id, text: claims.text, paperId: claims.paperId })
          .from(claims)
          .where(inArray(claims.id, claimIds))
      : [];
    const claimById = new Map(claimRows.map((c) => [c.id, c]));
    const paperIds = [...new Set(claimRows.map((c) => c.paperId))];
    const paperRows = paperIds.length
      ? await db
          .select({ id: papers.id, title: papers.title })
          .from(papers)
          .where(inArray(papers.id, paperIds))
      : [];
    const titleById = new Map(paperRows.map((p) => [p.id, p.title]));
    const claimInfo = (cid: string | undefined) => {
      const c = cid ? claimById.get(cid) : undefined;
      return {
        text: c?.text ?? null,
        paperTitle: c ? (titleById.get(c.paperId) ?? null) : null,
      };
    };

    const contradictions = cvRows.map((cv) => {
      const rel = relById.get(cv.claimRelationId);
      const from = claimInfo(rel?.fromClaimId);
      const to = claimInfo(rel?.toClaimId);
      return {
        id: cv.id,
        verdict: cv.verdict,
        rationale: cv.rationale,
        confidence: cv.confidence,
        severity: cv.severity,
        synthesisRationale: rel?.rationale ?? null,
        fromClaimText: from.text,
        fromPaperTitle: from.paperTitle,
        toClaimText: to.text,
        toPaperTitle: to.paperTitle,
      };
    });

    // Finding verdicts, resolved to the finding statement + synthesis label.
    const fvRows = await db
      .select({
        id: findingVerdicts.id,
        findingId: findingVerdicts.findingId,
        labelVerdict: findingVerdicts.labelVerdict,
        groundingVerdict: findingVerdicts.groundingVerdict,
        independenceNote: findingVerdicts.independenceNote,
        rationale: findingVerdicts.rationale,
        confidence: findingVerdicts.confidence,
        severity: findingVerdicts.severity,
      })
      .from(findingVerdicts)
      .where(eq(findingVerdicts.criticRunId, run.id));
    const fIds = fvRows.map((f) => f.findingId);
    const fRows = fIds.length
      ? await db
          .select({
            id: findings.id,
            statement: findings.statement,
            consensus: findings.consensus,
          })
          .from(findings)
          .where(inArray(findings.id, fIds))
      : [];
    const findingById = new Map(fRows.map((f) => [f.id, f]));

    const findingsOut = fvRows.map((fv) => {
      const f = findingById.get(fv.findingId);
      return {
        id: fv.id,
        statement: f?.statement ?? null,
        synthesisLabel: f?.consensus ?? null,
        labelVerdict: fv.labelVerdict,
        groundingVerdict: fv.groundingVerdict,
        independenceNote: fv.independenceNote,
        rationale: fv.rationale,
        confidence: fv.confidence,
        severity: fv.severity,
      };
    });

    return NextResponse.json({
      general: false,
      hasSynthesis,
      run: {
        id: run.id,
        createdAt: run.createdAt,
        completedAt: run.completedAt,
        notes: run.notes,
      },
      contradictions,
      findings: findingsOut,
    });
  } catch (error) {
    console.error("GET /api/critic/latest failed:", error);
    return NextResponse.json(
      { error: "Failed to load critic results." },
      { status: 500 },
    );
  }
}
