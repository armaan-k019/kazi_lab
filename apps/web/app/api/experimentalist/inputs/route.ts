import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import {
  criticAbstracts,
  criticRuns,
  crossDomainCriticRuns,
  crossDomainLinks,
  crossDomainRuns,
  db,
  isAllPapersLibrary,
  libraries,
  linkVerdicts,
} from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The three input modes' selectable options: Critic abstracts (latest per
// non-general library), the latest cross-domain run's links with their verdicts
// (confirmed/promoted first), and the non-general libraries (field mode).
export async function GET() {
  try {
    const libs = await db.select({ id: libraries.id, name: libraries.name }).from(libraries);
    const nameById = new Map(libs.map((l) => [l.id, l.name]));
    const realLibs = libs.filter((l) => !isAllPapersLibrary(l.name));

    // Latest Critic abstract per non-general library that has one with a claim.
    const absRows = await db
      .select({
        id: criticAbstracts.id,
        claim: criticAbstracts.claimToTest,
        title: criticAbstracts.title,
        libraryId: criticRuns.libraryId,
        completedAt: criticRuns.completedAt,
      })
      .from(criticAbstracts)
      .innerJoin(criticRuns, eq(criticRuns.id, criticAbstracts.criticRunId))
      .orderBy(desc(criticRuns.completedAt));
    const seenLib = new Set<string>();
    const abstracts: { id: string; library: string; claim: string }[] = [];
    for (const a of absRows) {
      if (seenLib.has(a.libraryId)) continue;
      const name = nameById.get(a.libraryId);
      if (isAllPapersLibrary(name)) continue;
      const claim = (a.claim ?? a.title ?? "").trim();
      if (!claim) continue;
      seenLib.add(a.libraryId);
      abstracts.push({ id: a.id, library: name ?? "library", claim });
    }

    // Latest completed cross-domain run's links + their latest verdicts.
    const [cdRun] = await db
      .select({ id: crossDomainRuns.id })
      .from(crossDomainRuns)
      .where(eq(crossDomainRuns.status, "completed"))
      .orderBy(desc(crossDomainRuns.completedAt))
      .limit(1);
    let links: {
      id: string;
      level: string;
      summary: string;
      isCandidate: boolean;
      source: string;
      verdict: string | null;
      libraries: string[];
    }[] = [];
    if (cdRun) {
      const linkRows = await db
        .select()
        .from(crossDomainLinks)
        .where(eq(crossDomainLinks.crossDomainRunId, cdRun.id));
      const [critique] = await db
        .select({ id: crossDomainCriticRuns.id })
        .from(crossDomainCriticRuns)
        .where(and(eq(crossDomainCriticRuns.crossDomainRunId, cdRun.id), eq(crossDomainCriticRuns.status, "completed")))
        .orderBy(desc(crossDomainCriticRuns.completedAt))
        .limit(1);
      const verdictByLink = new Map<string, string>();
      if (critique) {
        const vRows = await db
          .select({ linkId: linkVerdicts.linkId, verdict: linkVerdicts.verdict })
          .from(linkVerdicts)
          .where(eq(linkVerdicts.criticRunId, critique.id));
        for (const v of vRows) verdictByLink.set(v.linkId, v.verdict);
      }
      const rank = (v: string | null) =>
        v === "confirmed" ? 0 : v === "promoted" ? 1 : v === "demoted" ? 2 : v === "rejected" ? 4 : 3;
      links = linkRows
        .map((l) => ({
          id: l.id,
          level: l.level,
          summary: l.summary,
          isCandidate: l.isCandidate,
          source: l.source,
          verdict: verdictByLink.get(l.id) ?? null,
          libraries: l.libraryIds.map((id) => nameById.get(id) ?? "unknown"),
        }))
        .sort((a, b) => rank(a.verdict) - rank(b.verdict));
    }

    return NextResponse.json({
      abstracts,
      links,
      libraries: realLibs.map((l) => ({ id: l.id, name: l.name })),
    });
  } catch (error) {
    console.error("GET /api/experimentalist/inputs failed:", error);
    return NextResponse.json({ error: "Failed to load input options." }, { status: 500 });
  }
}
