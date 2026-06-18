import { NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  claims,
  claimRelations,
  db,
  embeddings,
  findings,
  findingPapers,
  openQuestions,
  paperExternal,
  paperLibraries,
  paperNarrations,
  papers,
  paperThemes,
  synthesisRuns,
  themes,
} from "@kazi-lab/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// pgvector may arrive as a number[] (drizzle) or a "[1,2,...]" string; coerce.
function toVector(v: unknown): number[] {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as number[];
    } catch {
      return [];
    }
  }
  return [];
}

// First principal component of the paper-level embeddings via power iteration
// (dependency-free), projected to a per-paper 1D coordinate normalized to 0..1.
// At ~20 papers x 1024 dims this is instant. Papers without an embedding are
// left out here and default to 0.5 at the call site.
function computeSemanticY(
  vectors: { paperId: string; emb: number[] }[],
): Map<string, number> {
  const out = new Map<string, number>();
  const m = vectors.length;
  if (m === 0) return out;
  const d = vectors[0].emb.length;
  if (d === 0) return out;

  const mean = new Array(d).fill(0);
  for (const { emb } of vectors)
    for (let j = 0; j < d; j++) mean[j] += emb[j];
  for (let j = 0; j < d; j++) mean[j] /= m;
  const X = vectors.map(({ emb }) => emb.map((x, j) => x - mean[j]));

  const normalize = (a: number[]) => {
    const n = Math.sqrt(a.reduce((s, x) => s + x * x, 0)) || 1;
    return a.map((x) => x / n);
  };
  // Deterministic non-zero seed (no Math.random) so layout is stable per load.
  let v = normalize(new Array(d).fill(0).map((_, j) => ((j % 7) + 1)));
  for (let iter = 0; iter < 50; iter++) {
    const t = X.map((row) => {
      let s = 0;
      for (let j = 0; j < d; j++) s += row[j] * v[j];
      return s;
    });
    const w = new Array(d).fill(0);
    for (let i = 0; i < m; i++) {
      const ti = t[i];
      const row = X[i];
      for (let j = 0; j < d; j++) w[j] += row[j] * ti;
    }
    v = normalize(w);
  }
  const scores = X.map((row) => {
    let s = 0;
    for (let j = 0; j < d; j++) s += row[j] * v[j];
    return s;
  });
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
  const range = hi - lo;
  vectors.forEach(({ paperId }, i) => {
    out.set(paperId, range > 1e-9 ? (scores[i] - lo) / range : 0.5);
  });
  return out;
}

// Full latest-completed-synthesis payload for a library, with all joins
// resolved so the client gets display-ready data. Returns { run: null } when
// the library has no completed run.
export async function GET(request: Request) {
  const libraryId = new URL(request.url).searchParams.get("libraryId");
  if (!libraryId) {
    return NextResponse.json({ error: "libraryId is required." }, { status: 400 });
  }

  try {
    const [run] = await db
      .select({
        id: synthesisRuns.id,
        completedAt: synthesisRuns.completedAt,
        paperCount: synthesisRuns.paperCount,
      })
      .from(synthesisRuns)
      .where(
        and(
          eq(synthesisRuns.libraryId, libraryId),
          eq(synthesisRuns.status, "completed"),
        ),
      )
      .orderBy(desc(synthesisRuns.completedAt))
      .limit(1);

    if (!run) return NextResponse.json({ run: null });

    // Papers currently in the library = the graph's nodes, with claim counts.
    const paperBase = await db
      .select({
        id: papers.id,
        title: papers.title,
        publishedAt: papers.publishedAt,
        claimCount: sql<number>`count(${claims.id})::int`,
      })
      .from(papers)
      .innerJoin(paperLibraries, eq(paperLibraries.paperId, papers.id))
      .leftJoin(claims, eq(claims.paperId, papers.id))
      .where(eq(paperLibraries.libraryId, libraryId))
      .groupBy(papers.id);

    const paperIds = paperBase.map((p) => p.id);

    // Claim lookup (id -> text, paperId) for resolving relations/supports, and
    // grouped per paper so the graph can render claim sub-nodes.
    const claimRows = paperIds.length
      ? await db
          .select({
            id: claims.id,
            paperId: claims.paperId,
            text: claims.text,
          })
          .from(claims)
          .where(inArray(claims.paperId, paperIds))
      : [];
    const claimMap = new Map(claimRows.map((c) => [c.id, c]));
    const claimsByPaper = new Map<string, { id: string; text: string }[]>();
    for (const c of claimRows) {
      const arr = claimsByPaper.get(c.paperId) ?? [];
      arr.push({ id: c.id, text: c.text });
      claimsByPaper.set(c.paperId, arr);
    }
    // Per-paper narration for this run (supplementary; may be absent).
    const narrationRows = await db
      .select({
        paperId: paperNarrations.paperId,
        narration: paperNarrations.narration,
      })
      .from(paperNarrations)
      .where(eq(paperNarrations.synthesisRunId, run.id));
    const narrationByPaper = new Map(
      narrationRows.map((n) => [n.paperId, n.narration]),
    );

    // Influence: cited_by_count from the matched OpenAlex record (null if
    // unmatched). Feeds node size and the "influence" Y axis.
    const citedRows = paperIds.length
      ? await db
          .select({
            paperId: paperExternal.paperId,
            citedByCount: paperExternal.citedByCount,
          })
          .from(paperExternal)
          .where(
            and(
              eq(paperExternal.source, "openalex"),
              eq(paperExternal.matchStatus, "matched"),
              inArray(paperExternal.paperId, paperIds),
            ),
          )
      : [];
    const citedByPaper = new Map(
      citedRows.map((c) => [c.paperId, c.citedByCount]),
    );

    // Semantic axis: PCA first component of the paper-level embeddings.
    const embRows = paperIds.length
      ? await db
          .select({ paperId: embeddings.paperId, embedding: embeddings.embedding })
          .from(embeddings)
          .where(
            and(
              eq(embeddings.entityType, "paper"),
              inArray(embeddings.paperId, paperIds),
            ),
          )
      : [];
    const semanticByPaper = computeSemanticY(
      embRows.map((e) => ({ paperId: e.paperId, emb: toVector(e.embedding) })),
    );

    const paperRows = paperBase.map((p) => ({
      ...p,
      claims: claimsByPaper.get(p.id) ?? [],
      narration: narrationByPaper.get(p.id) ?? null,
      citedByCount: citedByPaper.get(p.id) ?? null,
      semanticY: semanticByPaper.get(p.id) ?? 0.5,
    }));

    // Themes + their papers.
    const themeRows = await db
      .select({
        id: themes.id,
        name: themes.name,
        description: themes.description,
      })
      .from(themes)
      .where(eq(themes.synthesisRunId, run.id));
    const themeIds = themeRows.map((t) => t.id);
    const themeLinks = themeIds.length
      ? await db
          .select({ themeId: paperThemes.themeId, paperId: paperThemes.paperId })
          .from(paperThemes)
          .where(inArray(paperThemes.themeId, themeIds))
      : [];
    const themePapers = new Map<string, string[]>();
    for (const l of themeLinks) {
      const arr = themePapers.get(l.themeId) ?? [];
      arr.push(l.paperId);
      themePapers.set(l.themeId, arr);
    }
    const themesOut = themeRows.map((t) => ({
      ...t,
      paperIds: themePapers.get(t.id) ?? [],
    }));

    // Findings + supporting papers (with claim text where present).
    const findingRows = await db
      .select({
        id: findings.id,
        statement: findings.statement,
        detail: findings.detail,
        consensus: findings.consensus,
      })
      .from(findings)
      .where(eq(findings.synthesisRunId, run.id));
    const findingIds = findingRows.map((f) => f.id);
    const supportLinks = findingIds.length
      ? await db
          .select({
            findingId: findingPapers.findingId,
            paperId: findingPapers.paperId,
            supportingClaimId: findingPapers.supportingClaimId,
          })
          .from(findingPapers)
          .where(inArray(findingPapers.findingId, findingIds))
      : [];
    const findingSupports = new Map<
      string,
      { paperId: string; claimId: string | null; claimText: string | null }[]
    >();
    for (const s of supportLinks) {
      const arr = findingSupports.get(s.findingId) ?? [];
      arr.push({
        paperId: s.paperId,
        claimId: s.supportingClaimId,
        claimText: s.supportingClaimId
          ? (claimMap.get(s.supportingClaimId)?.text ?? null)
          : null,
      });
      findingSupports.set(s.findingId, arr);
    }
    const findingsOut = findingRows.map((f) => ({
      ...f,
      supports: findingSupports.get(f.id) ?? [],
    }));

    // Claim relations, resolved to claim text + owning paper.
    const relationRows = await db
      .select({
        id: claimRelations.id,
        fromClaimId: claimRelations.fromClaimId,
        toClaimId: claimRelations.toClaimId,
        relationType: claimRelations.relationType,
        rationale: claimRelations.rationale,
      })
      .from(claimRelations)
      .where(eq(claimRelations.synthesisRunId, run.id));
    const relationsOut = relationRows
      .map((r) => {
        const from = claimMap.get(r.fromClaimId);
        const to = claimMap.get(r.toClaimId);
        if (!from || !to) return null;
        return {
          id: r.id,
          relationType: r.relationType,
          rationale: r.rationale,
          fromClaimId: r.fromClaimId,
          toClaimId: r.toClaimId,
          fromClaimText: from.text,
          toClaimText: to.text,
          fromPaperId: from.paperId,
          toPaperId: to.paperId,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    // Open questions.
    const openQuestionRows = await db
      .select({
        id: openQuestions.id,
        question: openQuestions.question,
        rationale: openQuestions.rationale,
        relatedPaperIds: openQuestions.relatedPaperIds,
      })
      .from(openQuestions)
      .where(eq(openQuestions.synthesisRunId, run.id));

    return NextResponse.json({
      run: {
        id: run.id,
        completedAt: run.completedAt,
        paperCount: run.paperCount,
        counts: {
          themeCount: themesOut.length,
          findingCount: findingsOut.length,
          relationCount: relationsOut.length,
          openQuestionCount: openQuestionRows.length,
        },
      },
      papers: paperRows,
      themes: themesOut,
      findings: findingsOut,
      relations: relationsOut,
      openQuestions: openQuestionRows,
    });
  } catch (error) {
    console.error("GET /api/synthesis/results failed:", error);
    return NextResponse.json(
      { error: "Failed to load synthesis results." },
      { status: 500 },
    );
  }
}
