import { and, eq } from "drizzle-orm";
import { db, paperExternal, paperLibraries, papers } from "@kazi-lab/db";
import {
  getCitingWorks,
  getWork,
  getWorksByIds,
  type OpenAlexWork,
} from "./openalex";
import { shapeCandidates, type DiscoveryCandidate } from "./external-candidates";

const CITING_PER_PAPER = 25; // top citers fetched per library paper
const TOP_N = 15; // candidates returned

export type GapConnection = {
  type: "referenced" | "cites";
  libraryPaperTitle: string;
};

export type GapCandidate = DiscoveryCandidate & {
  connectionCount: number; // distinct connecting library papers
  connections: GapConnection[];
};

export type LibraryGapsResult =
  | { available: false; reason: string }
  | { available: true; candidates: GapCandidate[] };

// Find papers NOT in the corpus that connect to multiple library papers, either
// as shared references (foundational ancestors) or as works that cite multiple
// library members (the converging frontier). Ranked by connection count, then
// citations. Each candidate carries the connecting library papers as provenance.
export async function findLibraryGaps(
  libraryId: string,
): Promise<LibraryGapsResult> {
  const rows = await db
    .select({
      paperId: paperExternal.paperId,
      openalexId: paperExternal.openalexId,
      title: papers.title,
    })
    .from(paperExternal)
    .innerJoin(
      paperLibraries,
      and(
        eq(paperLibraries.paperId, paperExternal.paperId),
        eq(paperLibraries.libraryId, libraryId),
      ),
    )
    .innerJoin(papers, eq(papers.id, paperExternal.paperId))
    .where(
      and(
        eq(paperExternal.source, "openalex"),
        eq(paperExternal.matchStatus, "matched"),
      ),
    );

  const libPapers = rows.filter((r) => r.openalexId);
  if (libPapers.length < 2) {
    return {
      available: false,
      reason: "Need at least 2 matched papers in this library to find gaps.",
    };
  }
  const libIds = new Set(libPapers.map((r) => r.openalexId as string));

  type Tally = {
    connectionsByPaper: Map<string, Set<"referenced" | "cites">>;
    meta?: OpenAlexWork;
  };
  const tally = new Map<string, Tally>();
  const addConn = (
    extId: string,
    libTitle: string,
    type: "referenced" | "cites",
    meta?: OpenAlexWork,
  ) => {
    if (!extId || libIds.has(extId)) return; // skip library papers themselves
    let t = tally.get(extId);
    if (!t) {
      t = { connectionsByPaper: new Map() };
      tally.set(extId, t);
    }
    if (!t.connectionsByPaper.has(libTitle)) {
      t.connectionsByPaper.set(libTitle, new Set());
    }
    t.connectionsByPaper.get(libTitle)!.add(type);
    if (meta && !t.meta) t.meta = meta;
  };

  for (const lp of libPapers) {
    const oa = lp.openalexId as string;
    const work = await getWork(oa).catch(() => null);
    if (work) {
      for (const refId of work.referencedWorkIds) {
        addConn(refId, lp.title, "referenced");
      }
    }
    const citing = await getCitingWorks(oa, CITING_PER_PAPER).catch(() => []);
    for (const c of citing) addConn(c.openalexId, lp.title, "cites", c);
  }

  let entries = [...tally.entries()].map(([extId, t]) => ({
    extId,
    connectionCount: t.connectionsByPaper.size,
    connections: [...t.connectionsByPaper.entries()].flatMap(([title, types]) =>
      [...types].map((type) => ({ type, libraryPaperTitle: title })),
    ),
    meta: t.meta,
  }));

  // Intersection signal: keep works connected to >= 2 library papers.
  entries = entries.filter((e) => e.connectionCount >= 2);
  if (entries.length === 0) return { available: true, candidates: [] };

  // Resolve metadata for shared references (citing works already carry it),
  // limited to a shortlist by connection count to bound the batch fetch.
  entries.sort((a, b) => b.connectionCount - a.connectionCount);
  const shortlist = entries.slice(0, TOP_N * 2);
  const needMeta = shortlist.filter((e) => !e.meta).map((e) => e.extId);
  if (needMeta.length > 0) {
    const fetched = await getWorksByIds(needMeta);
    const byId = new Map(fetched.map((w) => [w.openalexId, w]));
    for (const e of shortlist) if (!e.meta) e.meta = byId.get(e.extId);
  }

  shortlist.sort(
    (a, b) =>
      b.connectionCount - a.connectionCount ||
      (b.meta?.citedByCount ?? 0) - (a.meta?.citedByCount ?? 0),
  );
  const top = shortlist.slice(0, TOP_N).filter((e) => e.meta);

  const shaped = await shapeCandidates(
    top.map((e) => e.meta as OpenAlexWork),
    libraryId,
  );

  const candidates: GapCandidate[] = [];
  for (let i = 0; i < top.length; i++) {
    if (shaped[i].inCorpus) continue; // exclude works already in the corpus
    candidates.push({
      ...shaped[i],
      connectionCount: top[i].connectionCount,
      connections: top[i].connections,
    });
  }
  return { available: true, candidates };
}
