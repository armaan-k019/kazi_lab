import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { crossDomainLinks, crossDomainRuns, db, isAllPapersLibrary, libraries, webBuildRuns, webCommunities, webNodes } from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Botany inputs that the pipeline route does not carry: INTERNAL citation
// density (real edges among a library's own papers), the library's dominant
// community in the latest web run (foliage hue), and the real cross-domain
// links between library pairs (the bridges-as-growth). All real data; the
// tree generator derives everything from this plus the pipeline stages.
export async function GET() {
  try {
    const libs = await db.select({ id: libraries.id, name: libraries.name }).from(libraries);

    // Internal citation edges: citing AND cited papers both in the library.
    const internal = await db
      .execute<{ library_id: string; edges: number }>(sql`
        select a.library_id, count(*)::int edges
        from citations c
        join paper_libraries a on a.paper_id = c.citing_paper_id
        join paper_libraries b on b.paper_id = c.cited_paper_id
        where a.library_id = b.library_id and c.cited_paper_id is not null
        group by a.library_id`)
      .then((r) => r.rows);
    const edgesBy = new Map(internal.map((r) => [r.library_id, r.edges]));

    const paperCounts = await db
      .execute<{ library_id: string; c: number }>(sql`select library_id, count(*)::int c from paper_libraries group by library_id`)
      .then((r) => r.rows);
    const papersBy = new Map(paperCounts.map((r) => [r.library_id, r.c]));

    // Dominant community per library from the latest completed web run.
    const [run] = await db.select({ id: webBuildRuns.id }).from(webBuildRuns).where(eq(webBuildRuns.status, "completed")).orderBy(desc(webBuildRuns.createdAt)).limit(1);
    const communityBy = new Map<string, number>();
    if (run) {
      const rows = await db
        .execute<{ library_id: string; community_index: number; c: number }>(sql`
          select pl.library_id, wc.community_index, count(*)::int c
          from web_nodes n
          join web_communities wc on wc.id = n.community_id
          join paper_libraries pl on pl.paper_id = n.ref_id
          where n.run_id = ${run.id} and n.kind = 'paper'
          group by pl.library_id, wc.community_index
          order by c desc`)
        .then((r) => r.rows);
      for (const r of rows) if (!communityBy.has(r.library_id)) communityBy.set(r.library_id, r.community_index);
    }

    // Bridges: links of the latest completed cross-domain run, grouped by
    // unordered library pair. Strength = link count; the top summary names it.
    const [cd] = await db.select({ id: crossDomainRuns.id }).from(crossDomainRuns).where(eq(crossDomainRuns.status, "completed")).orderBy(desc(crossDomainRuns.completedAt)).limit(1);
    const bridges: { a: string; b: string; linkCount: number; summary: string; level: string }[] = [];
    if (cd) {
      const links = await db
        .select({ libraryIds: crossDomainLinks.libraryIds, summary: crossDomainLinks.summary, level: crossDomainLinks.level })
        .from(crossDomainLinks)
        .where(and(eq(crossDomainLinks.crossDomainRunId, cd.id)));
      const byPair = new Map<string, { a: string; b: string; linkCount: number; summary: string; level: string }>();
      for (const l of links) {
        for (let i = 0; i < l.libraryIds.length; i++) {
          for (let j = i + 1; j < l.libraryIds.length; j++) {
            const [a, b] = [l.libraryIds[i], l.libraryIds[j]].sort();
            const key = `${a}:${b}`;
            const existing = byPair.get(key);
            if (existing) existing.linkCount += 1;
            else byPair.set(key, { a, b, linkCount: 1, summary: l.summary, level: l.level });
          }
        }
      }
      bridges.push(...byPair.values());
    }

    return NextResponse.json({
      libraries: libs
        .filter((l) => !isAllPapersLibrary(l.name))
        .map((l) => {
          const papers = papersBy.get(l.id) ?? 0;
          const edges = edgesBy.get(l.id) ?? 0;
          return {
            id: l.id,
            name: l.name,
            internalCitationEdges: edges,
            internalCitationDensity: papers > 0 ? edges / papers : 0,
            communityIndex: communityBy.get(l.id) ?? null,
          };
        }),
      bridges,
    });
  } catch (error) {
    console.error("GET /api/botany failed:", error);
    return NextResponse.json({ error: "Failed to derive botany inputs." }, { status: 500 });
  }
}
