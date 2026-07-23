import { NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  crossDomainCriticRuns,
  crossDomainLinkEvidence,
  crossDomainLinks,
  crossDomainRuns,
  db,
  linkVerdicts,
  paperExternal,
  webBridges,
  webBuildRuns,
  webCommunities,
  webEdges,
  webNodes,
} from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Web view payload: the latest completed build's paper-projection graph
// (paper nodes colored by community + direct paper-paper edges), communities,
// bridges, ABC candidates, and any web_discovery proposals with their verdicts.
export async function GET(request: Request) {
  try {
    const runId = new URL(request.url).searchParams.get("runId");
    const [run] = runId
      ? await db.select().from(webBuildRuns).where(eq(webBuildRuns.id, runId)).limit(1)
      : await db
          .select()
          .from(webBuildRuns)
          .where(eq(webBuildRuns.status, "completed"))
          .orderBy(desc(webBuildRuns.completedAt))
          .limit(1);
    if (!run) return NextResponse.json({ run: null });

    const communities = await db.select().from(webCommunities).where(eq(webCommunities.runId, run.id));
    const commIndexById = new Map(communities.map((c) => [c.id, c.communityIndex]));

    // Paper nodes only, for the projection graph.
    const paperNodeRows = await db
      .select()
      .from(webNodes)
      .where(and(eq(webNodes.runId, run.id), eq(webNodes.kind, "paper")));
    const nodeIdToPaper = new Map(paperNodeRows.map((n) => [n.id, n]));
    const paperNodeIds = new Set(paperNodeRows.map((n) => n.id));

    // Direct paper-paper edges (semantic + cites) for the visual.
    const ppEdges = (
      await db
        .select()
        .from(webEdges)
        .where(and(eq(webEdges.runId, run.id), inArray(webEdges.kind, ["semantic", "cites"])))
    ).filter((e) => paperNodeIds.has(e.srcNodeId) && paperNodeIds.has(e.dstNodeId));

    const bridges = await db.select().from(webBridges).where(eq(webBridges.runId, run.id));
    const nodeBridgePaperIds = new Set(
      bridges.filter((b) => b.kind === "node_bridge").map((b) => (b.payload as { paper_id?: string }).paper_id).filter(Boolean) as string[],
    );

    // Influence = OpenAlex citation count where known, else claim count. Drives
    // point size in the 3D view.
    const paperRefIds = paperNodeRows.map((n) => n.refId).filter((x): x is string => !!x);
    const citeCounts = new Map<string, number>();
    const claimCounts = new Map<string, number>();
    if (paperRefIds.length) {
      const ex = await db.select({ paperId: paperExternal.paperId, cited: paperExternal.citedByCount }).from(paperExternal).where(inArray(paperExternal.paperId, paperRefIds));
      for (const e of ex) if (e.cited != null) citeCounts.set(e.paperId, e.cited);
      const cc = await db.execute<{ paper_id: string; c: number }>(sql`select paper_id, count(*)::int c from claims where paper_id in (${sql.join(paperRefIds.map((id) => sql`${id}`), sql`, `)}) group by paper_id`);
      for (const r of cc.rows) claimCounts.set(r.paper_id, r.c);
    }

    const nodes = paperNodeRows.map((n) => ({
      id: n.id,
      refId: n.refId,
      label: n.label,
      community: n.communityId ? commIndexById.get(n.communityId) ?? null : null,
      degree: n.degree,
      isBridge: n.refId ? nodeBridgePaperIds.has(n.refId) : false,
      influence: n.refId ? (citeCounts.get(n.refId) ?? claimCounts.get(n.refId) ?? 0) : 0,
      x: n.coordX,
      y: n.coordY,
      z: n.coordZ,
    }));
    const edges = ppEdges.map((e) => ({
      src: nodeIdToPaper.get(e.srcNodeId)?.refId ?? null,
      dst: nodeIdToPaper.get(e.dstNodeId)?.refId ?? null,
      kind: e.kind,
      weight: e.weight,
    }));

    const abc = bridges
      .filter((b) => b.kind === "abc")
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((b) => ({ score: b.score, payload: b.payload }));
    const nodeBridges = bridges.filter((b) => b.kind === "node_bridge").sort((a, b) => b.score - a.score).slice(0, 8).map((b) => ({ score: b.score, payload: b.payload }));

    // web_discovery proposals: the latest cross_domain_run whose notes reference
    // this web run, with the links + their latest verdicts.
    const cdRuns = await db
      .select()
      .from(crossDomainRuns)
      .where(eq(crossDomainRuns.status, "completed"))
      .orderBy(desc(crossDomainRuns.completedAt));
    const cdRun = cdRuns.find((r) => (r.notes ?? "").includes(`web discovery run ${run.id}`));
    let discoveries: {
      id: string;
      level: string;
      summary: string;
      rationale: string | null;
      verdict: string | null;
      evidence: { kind: string; ref: string; excerpt: string | null }[];
    }[] = [];
    if (cdRun) {
      const links = (await db.select().from(crossDomainLinks).where(eq(crossDomainLinks.crossDomainRunId, cdRun.id))).filter((l) => l.source === "web_discovery");
      const [critique] = await db
        .select({ id: crossDomainCriticRuns.id })
        .from(crossDomainCriticRuns)
        .where(and(eq(crossDomainCriticRuns.crossDomainRunId, cdRun.id), eq(crossDomainCriticRuns.status, "completed")))
        .orderBy(desc(crossDomainCriticRuns.completedAt))
        .limit(1);
      const verdictByLink = new Map<string, string>();
      if (critique) {
        const vRows = await db.select({ linkId: linkVerdicts.linkId, verdict: linkVerdicts.verdict }).from(linkVerdicts).where(eq(linkVerdicts.criticRunId, critique.id));
        for (const v of vRows) verdictByLink.set(v.linkId, v.verdict);
      }
      const evByLink = new Map<string, { kind: string; ref: string; excerpt: string | null }[]>();
      if (links.length) {
        const evRows = await db.select().from(crossDomainLinkEvidence).where(inArray(crossDomainLinkEvidence.linkId, links.map((l) => l.id)));
        for (const e of evRows) {
          const arr = evByLink.get(e.linkId) ?? [];
          arr.push({ kind: e.evidenceKind, ref: e.evidenceRef, excerpt: e.excerpt });
          evByLink.set(e.linkId, arr);
        }
      }
      discoveries = links.map((l) => ({ id: l.id, level: l.level, summary: l.summary, rationale: l.rationale, verdict: verdictByLink.get(l.id) ?? null, evidence: evByLink.get(l.id) ?? [] }));
    }

    return NextResponse.json({
      run: { id: run.id, params: run.params, stats: run.stats, completedAt: run.completedAt },
      communities: communities.map((c) => ({ index: c.communityIndex, label: c.label, size: c.size })).sort((a, b) => a.index - b.index),
      nodes,
      edges,
      abc,
      nodeBridges,
      discoveries,
    });
  } catch (error) {
    console.error("GET /api/web/latest failed:", error);
    return NextResponse.json({ error: "Failed to load the research web." }, { status: 500 });
  }
}
