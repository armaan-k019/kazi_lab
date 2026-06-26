import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  crossDomainLinkEvidence,
  crossDomainLinks,
  crossDomainRuns,
  db,
  isAllPapersLibrary,
  libraries,
  synthesisRuns,
} from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The latest completed cross-domain run, with its links grouped by level and the
// evidence (with library names) for each. Also reports how many libraries are
// eligible so the UI can show the calm "need at least two" message.
export async function GET() {
  try {
    const allLibs = await db
      .select({ id: libraries.id, name: libraries.name })
      .from(libraries);
    const libName = new Map(allLibs.map((l) => [l.id, l.name]));

    // Eligible = non-general libraries with a completed synthesis.
    const eligible: { id: string; name: string }[] = [];
    for (const l of allLibs) {
      if (isAllPapersLibrary(l.name)) continue;
      const [synth] = await db
        .select({ id: synthesisRuns.id })
        .from(synthesisRuns)
        .where(and(eq(synthesisRuns.libraryId, l.id), eq(synthesisRuns.status, "completed")))
        .limit(1);
      if (synth) eligible.push({ id: l.id, name: l.name });
    }

    const [run] = await db
      .select({
        id: crossDomainRuns.id,
        scope: crossDomainRuns.scope,
        notes: crossDomainRuns.notes,
        createdAt: crossDomainRuns.createdAt,
        completedAt: crossDomainRuns.completedAt,
      })
      .from(crossDomainRuns)
      .where(eq(crossDomainRuns.status, "completed"))
      .orderBy(desc(crossDomainRuns.completedAt))
      .limit(1);

    if (!run) {
      return NextResponse.json({ eligible, run: null, links: [] });
    }

    const linkRows = await db
      .select()
      .from(crossDomainLinks)
      .where(eq(crossDomainLinks.crossDomainRunId, run.id));
    const linkIds = linkRows.map((l) => l.id);
    const evRows = linkIds.length
      ? await db
          .select()
          .from(crossDomainLinkEvidence)
          .where(inArray(crossDomainLinkEvidence.linkId, linkIds))
      : [];
    const evByLink = new Map<string, typeof evRows>();
    for (const e of evRows) {
      const arr = evByLink.get(e.linkId) ?? [];
      arr.push(e);
      evByLink.set(e.linkId, arr);
    }

    const links = linkRows.map((l) => ({
      id: l.id,
      level: l.level,
      summary: l.summary,
      confidence: l.confidence,
      isCandidate: l.isCandidate,
      rationale: l.rationale,
      libraries: l.libraryIds.map((id) => ({ id, name: libName.get(id) ?? "unknown" })),
      evidence: (evByLink.get(l.id) ?? []).map((e) => ({
        id: e.id,
        libraryName: libName.get(e.libraryId) ?? "unknown",
        kind: e.evidenceKind,
        ref: e.evidenceRef,
        excerpt: e.excerpt,
      })),
    }));

    return NextResponse.json({
      eligible,
      run: {
        id: run.id,
        scope: run.scope.map((id) => libName.get(id) ?? "unknown"),
        notes: run.notes,
        createdAt: run.createdAt,
        completedAt: run.completedAt,
      },
      links,
    });
  } catch (error) {
    console.error("GET /api/cross-domain/latest failed:", error);
    return NextResponse.json(
      { error: "Failed to load cross-domain results." },
      { status: 500 },
    );
  }
}
