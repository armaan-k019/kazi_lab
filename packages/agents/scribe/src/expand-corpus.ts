import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  db,
  expansionCandidates,
  expansionFrontier,
  expansionRuns,
  libraries,
  paperExternal,
  paperLibraries,
  papers,
  embeddings,
  type ExpansionCandidate,
  type ExpansionRun,
} from "@kazi-lab/db";
import { AUTH_FAILURE_RE, EXPANSION, TRANSIENT_NETWORK_RE } from "./expansion-config";
import {
  fetchCitations,
  fetchReferences,
  resolveSemanticScholar,
  semanticScholarKeyStatus,
  type SSNeighbor,
} from "./semantic-scholar";
import { getWork, getWorkByDoi } from "./openalex";
import { ingestPaper } from "./ingest";

// ---------------------------------------------------------------------------
// CONTROLLED CORPUS EXPANSION. Every candidate is reached through the real
// citation graph from existing corpus papers (no keyword search exists in this
// file), passes the documented relevance bar in expansion-config.ts, and must
// resolve to a real ingestable source or be skipped with a recorded reason.
// The expansion_* tables are the checkpoint: every transition is transactional,
// so a crash, timeout, or credit exhaustion at any point leaves a consistent
// state and a restart continues with no duplicates and no partial papers.
// ---------------------------------------------------------------------------

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

// Walk the cause chain so a wrapped drizzle/pg error still matches.
export function isTransientNetworkError(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 6; depth++) {
    const err = cur as { message?: string; code?: string; cause?: unknown };
    if (TRANSIENT_NETWORK_RE.test(`${err.message ?? ""} ${err.code ?? ""}`)) return true;
    cur = err.cause;
  }
  return false;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const short = (s: string, n = 300) => (s.length > n ? s.slice(0, n) : s);

// -- corpus identity -----------------------------------------------------------

type CorpusMaps = {
  byArxiv: Map<string, string>;
  byDoi: Map<string, string>;
  byTitle: Map<string, string>;
  byS2: Set<string>;
  corpusSize: number;
};

// Everything already in the corpus, for dedup. byS2 comes from this run's own
// frontier resolutions and ingested candidates (Semantic Scholar ids are not
// first-class corpus data, but within a run we know them).
async function loadCorpusMaps(runId: string): Promise<CorpusMaps> {
  const corpus = await db
    .select({ id: papers.id, arxivId: papers.arxivId, title: papers.title })
    .from(papers);
  const ext = await db
    .select({ paperId: paperExternal.paperId, doi: paperExternal.doi })
    .from(paperExternal);
  const doiByPaper = new Map(ext.filter((e) => e.doi).map((e) => [e.paperId, e.doi!.toLowerCase()]));

  const byArxiv = new Map<string, string>();
  const byDoi = new Map<string, string>();
  const byTitle = new Map<string, string>();
  for (const p of corpus) {
    if (p.arxivId) byArxiv.set(p.arxivId.toLowerCase(), p.id);
    const doi = doiByPaper.get(p.id);
    if (doi) byDoi.set(doi, p.id);
    if (p.title) byTitle.set(normTitle(p.title), p.id);
  }

  const byS2 = new Set<string>();
  const frontier = await db
    .select({ s2: expansionFrontier.s2PaperId })
    .from(expansionFrontier)
    .where(eq(expansionFrontier.runId, runId));
  for (const f of frontier) if (f.s2) byS2.add(f.s2);
  const ingested = await db
    .select({ s2: expansionCandidates.s2PaperId })
    .from(expansionCandidates)
    .where(and(eq(expansionCandidates.runId, runId), eq(expansionCandidates.status, "ingested")));
  for (const c of ingested) byS2.add(c.s2);

  return { byArxiv, byDoi, byTitle, byS2, corpusSize: corpus.length };
}

// -- run lifecycle -------------------------------------------------------------

export type RunOverrides = { targetNew?: number; waveSize?: number };

// Resume the latest resumable run, else create one and seed its frontier with
// the entire current corpus (wave 0 = verified ground).
export async function getOrCreateRun(overrides: RunOverrides = {}): Promise<{ run: ExpansionRun; resumed: boolean }> {
  const [existing] = await db
    .select()
    .from(expansionRuns)
    .where(inArray(expansionRuns.status, ["running", "stopped"]))
    .orderBy(desc(expansionRuns.createdAt))
    .limit(1);
  if (existing) {
    await db
      .update(expansionRuns)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(expansionRuns.id, existing.id));
    return { run: { ...existing, status: "running" }, resumed: true };
  }

  const corpus = await db.select({ id: papers.id }).from(papers);
  const libCounts = await db
    .select({ name: libraries.name, n: sql<number>`count(${paperLibraries.paperId})::int` })
    .from(libraries)
    .leftJoin(paperLibraries, eq(paperLibraries.libraryId, libraries.id))
    .groupBy(libraries.name);

  const [run] = await db
    .insert(expansionRuns)
    .values({
      targetNew: overrides.targetNew ?? EXPANSION.TARGET_NEW,
      waveSize: overrides.waveSize ?? EXPANSION.WAVE_SIZE,
      status: "running",
      corpusSizeStart: corpus.length,
      libraryCountsStart: Object.fromEntries(libCounts.map((l) => [l.name, l.n])),
      params: EXPANSION,
    })
    .returning();

  // Seed the frontier with every current corpus paper. onConflictDoNothing
  // makes reseeding after a crash harmless.
  for (let i = 0; i < corpus.length; i += 200) {
    await db
      .insert(expansionFrontier)
      .values(corpus.slice(i, i + 200).map((p) => ({ runId: run.id, paperId: p.id, joinedWave: 0 })))
      .onConflictDoNothing();
  }
  return { run, resumed: false };
}

// -- discovery -----------------------------------------------------------------

// Fetch one frontier paper's citation neighborhood and merge each not-in-corpus
// neighbor into the candidate pool. The merge and the frontier status update
// happen in ONE transaction, so a restart never double-counts a neighbor.
async function discoverFrontierPaper(
  run: ExpansionRun,
  row: { id: string; paperId: string },
  maps: CorpusMaps,
): Promise<{ merged: number; newCandidates: number } | null> {
  const [p] = await db
    .select({ id: papers.id, arxivId: papers.arxivId, title: papers.title })
    .from(papers)
    .where(eq(papers.id, row.paperId))
    .limit(1);
  if (!p) return null;
  const [ext] = await db
    .select({ doi: paperExternal.doi })
    .from(paperExternal)
    .where(eq(paperExternal.paperId, row.paperId))
    .limit(1);

  const ss = await resolveSemanticScholar({ arxivId: p.arxivId, doi: ext?.doi ?? null, title: p.title });
  if (!ss) {
    await db
      .update(expansionFrontier)
      .set({ status: "unresolved", updatedAt: new Date() })
      .where(eq(expansionFrontier.id, row.id));
    return null;
  }
  maps.byS2.add(ss.paperId);

  const refs = await fetchReferences(ss.paperId, EXPANSION.NEIGHBOR_LIMIT);
  const cites = await fetchCitations(ss.paperId, EXPANSION.NEIGHBOR_LIMIT);

  // Dedupe neighbors within this paper (a neighbor can be both a reference and
  // a citer); influential if any of its edges is influential.
  const neighbors = new Map<string, SSNeighbor>();
  for (const n of [...refs, ...cites]) {
    if (!n.paperId) continue; // no Semantic Scholar id, cannot dedup safely: skip
    const prev = neighbors.get(n.paperId);
    if (prev) prev.isInfluential = prev.isInfluential || n.isInfluential;
    else neighbors.set(n.paperId, { ...n });
  }

  // Drop anything already in the corpus.
  const fresh = [...neighbors.values()].filter((n) => {
    if (maps.byS2.has(n.paperId!)) return false;
    if (n.arxivId && maps.byArxiv.has(n.arxivId.toLowerCase())) return false;
    if (n.doi && maps.byDoi.has(n.doi.toLowerCase())) return false;
    if (n.title && maps.byTitle.has(normTitle(n.title))) return false;
    return n.title.trim().length > 0;
  });

  let newCandidates = 0;
  await db.transaction(async (tx) => {
    const ids = fresh.map((n) => n.paperId!);
    const existing = ids.length
      ? await tx
          .select()
          .from(expansionCandidates)
          .where(and(eq(expansionCandidates.runId, run.id), inArray(expansionCandidates.s2PaperId, ids)))
      : [];
    const byId = new Map(existing.map((c) => [c.s2PaperId, c]));

    const toInsert = fresh.filter((n) => !byId.has(n.paperId!));
    for (let i = 0; i < toInsert.length; i += 100) {
      await tx
        .insert(expansionCandidates)
        .values(
          toInsert.slice(i, i + 100).map((n) => ({
            runId: run.id,
            s2PaperId: n.paperId!,
            title: short(n.title),
            arxivId: n.arxivId,
            doi: n.doi,
            fieldsOfStudy: n.fieldsOfStudy,
            citationCount: n.citationCount,
            linkedPaperIds: [p.id],
            influentialFromIds: n.isInfluential ? [p.id] : [],
            corpusLinks: 1,
            influentialLinks: n.isInfluential ? 1 : 0,
          })),
        )
        .onConflictDoNothing();
      newCandidates += Math.min(100, toInsert.length - i);
    }

    // Existing candidates gain this corpus link if they did not have it yet.
    for (const n of fresh) {
      const c = byId.get(n.paperId!);
      if (!c || c.linkedPaperIds.includes(p.id)) continue;
      const linked = [...c.linkedPaperIds, p.id];
      const infl = n.isInfluential ? [...c.influentialFromIds, p.id] : c.influentialFromIds;
      await tx
        .update(expansionCandidates)
        .set({
          linkedPaperIds: linked,
          influentialFromIds: infl,
          corpusLinks: linked.length,
          influentialLinks: infl.length,
          citationCount: c.citationCount ?? n.citationCount,
          updatedAt: new Date(),
        })
        .where(eq(expansionCandidates.id, c.id));
    }

    await tx
      .update(expansionFrontier)
      .set({
        status: "fetched",
        s2PaperId: ss.paperId,
        fields: ss.fieldsOfStudy,
        refsFound: refs.length,
        citesFound: cites.length,
        updatedAt: new Date(),
      })
      .where(eq(expansionFrontier.id, row.id));
  });

  return { merged: fresh.length, newCandidates };
}

// Process every pending frontier row (resume-safe: fetched rows are skipped).
export async function discoverPending(run: ExpansionRun, log: (m: string) => void): Promise<void> {
  // "unresolved" can be poisoned by a network outage (resolution failure looks
  // identical to a genuine missing record). Re-check them each pass: one cheap
  // call per paper reconfirms the honest verdict.
  await db
    .update(expansionFrontier)
    .set({ status: "pending", updatedAt: new Date() })
    .where(and(eq(expansionFrontier.runId, run.id), eq(expansionFrontier.status, "unresolved")));
  const pending = await db
    .select({ id: expansionFrontier.id, paperId: expansionFrontier.paperId })
    .from(expansionFrontier)
    .where(and(eq(expansionFrontier.runId, run.id), eq(expansionFrontier.status, "pending")))
    .orderBy(asc(expansionFrontier.id));
  if (pending.length === 0) return;
  log(`discovery: ${pending.length} frontier papers to fetch (Semantic Scholar ${semanticScholarKeyStatus()})`);
  const maps = await loadCorpusMaps(run.id);
  let done = 0;
  for (const row of pending) {
    try {
      const r = await discoverFrontierPaper(run, row, maps);
      done++;
      if (done % 20 === 0) log(`discovery: ${done}/${pending.length} fetched${r ? "" : " (last unresolved)"}`);
    } catch (e) {
      // Transient failure: leave the row pending for the next invocation.
      log(`discovery: frontier ${row.paperId.slice(0, 8)} failed: ${(e as Error).message}`);
    }
  }
  log(`discovery: done (${done}/${pending.length})`);
}

// -- relevance filter ----------------------------------------------------------

export type FieldDistribution = Record<string, number>;

// share(f) = corpus papers listing f / corpus papers with any field data,
// computed over the resolved frontier (which IS the corpus, wave by wave).
export async function computeFieldDistribution(runId: string): Promise<FieldDistribution> {
  const rows = await db
    .select({ fields: expansionFrontier.fields })
    .from(expansionFrontier)
    .where(and(eq(expansionFrontier.runId, runId), eq(expansionFrontier.status, "fetched")));
  const withData = rows
    .map((r) => (Array.isArray(r.fields) ? (r.fields as string[]) : []))
    .filter((f) => f.length > 0);
  const dist: FieldDistribution = {};
  for (const fields of withData) {
    for (const f of new Set(fields)) dist[f] = (dist[f] ?? 0) + 1;
  }
  for (const f of Object.keys(dist)) dist[f] = dist[f] / withData.length;
  return dist;
}

export type Verdict = {
  fieldFit: number | null;
  eligible: boolean;
  reason: string | null;
  score: number;
};

// The documented bar, as a pure function (see expansion-config.ts for the
// rationale of every threshold).
export function evaluateCandidate(
  c: Pick<ExpansionCandidate, "corpusLinks" | "influentialLinks" | "fieldsOfStudy" | "citationCount">,
  dist: FieldDistribution,
): Verdict {
  const fields = Array.isArray(c.fieldsOfStudy) ? (c.fieldsOfStudy as string[]) : [];
  const fieldFit = fields.length ? Math.max(0, ...fields.map((f) => dist[f] ?? 0)) : null;

  let eligible = false;
  let reason: string | null = null;
  if (c.corpusLinks >= EXPANSION.MIN_CORPUS_LINKS) {
    if (fieldFit === null) {
      eligible = c.corpusLinks >= EXPANSION.MIN_LINKS_UNKNOWN_FIELDS;
      if (!eligible) reason = `no field data and only ${c.corpusLinks} corpus links (need ${EXPANSION.MIN_LINKS_UNKNOWN_FIELDS})`;
    } else if (fieldFit >= EXPANSION.FIELD_FIT_MIN) {
      eligible = true;
    } else {
      reason = `field fit ${fieldFit.toFixed(2)} below ${EXPANSION.FIELD_FIT_MIN}`;
    }
  } else if (c.corpusLinks === 1) {
    if (c.influentialLinks >= 1 && fieldFit !== null && fieldFit >= EXPANSION.FIELD_FIT_SINGLE_LINK_MIN) {
      eligible = true;
    } else if (c.influentialLinks === 0) {
      reason = "single weak link to the corpus";
    } else {
      reason = `single influential link but field fit ${fieldFit === null ? "unknown" : fieldFit.toFixed(2)} below ${EXPANSION.FIELD_FIT_SINGLE_LINK_MIN}`;
    }
  } else {
    reason = "no corpus links";
  }

  const prominence = Math.min(1, Math.log10(1 + (c.citationCount ?? 0)) / 4);
  const score =
    EXPANSION.W_LINKS * Math.min(c.corpusLinks, EXPANSION.LINKS_CAP) +
    EXPANSION.W_INFLUENTIAL * Math.min(c.influentialLinks, EXPANSION.INFLUENTIAL_CAP) +
    EXPANSION.W_FIELD_FIT * (fieldFit ?? EXPANSION.FIELD_FIT_MIN) +
    EXPANSION.W_PROMINENCE * prominence;

  return { fieldFit, eligible, reason, score };
}

// Re-evaluate every pending candidate against the current field distribution
// (the corpus grows wave by wave, so the bar's inputs refresh with it).
export async function evaluatePending(run: ExpansionRun, dist: FieldDistribution, log: (m: string) => void): Promise<void> {
  const pending = await db
    .select()
    .from(expansionCandidates)
    .where(and(eq(expansionCandidates.runId, run.id), eq(expansionCandidates.status, "pending")));
  log(`evaluate: ${pending.length} pending candidates against the relevance bar`);
  const CHUNK = 25;
  for (let i = 0; i < pending.length; i += CHUNK) {
    await Promise.all(
      pending.slice(i, i + CHUNK).map(async (c) => {
        const v = evaluateCandidate(c, dist);
        if (
          c.eligible === v.eligible &&
          c.score === v.score &&
          c.fieldFit === v.fieldFit &&
          c.ineligibleReason === v.reason
        )
          return;
        await db
          .update(expansionCandidates)
          .set({ fieldFit: v.fieldFit, score: v.score, eligible: v.eligible, ineligibleReason: v.reason, updatedAt: new Date() })
          .where(eq(expansionCandidates.id, c.id));
      }),
    );
  }
  await db
    .update(expansionRuns)
    .set({ fieldDistribution: dist, updatedAt: new Date() })
    .where(eq(expansionRuns.id, run.id));
}

// -- selection, source resolution, library assignment --------------------------

// Reset crash leftovers and retryables, then deterministically select the top
// eligible candidates for this wave.
export async function selectWave(run: ExpansionRun, wave: number, capacity: number): Promise<ExpansionCandidate[]> {
  // Crash leftovers: selected but never finished.
  await db
    .update(expansionCandidates)
    .set({ status: "pending", updatedAt: new Date() })
    .where(and(eq(expansionCandidates.runId, run.id), eq(expansionCandidates.status, "selected")));
  // Retryables back into the pool; exhausted ones become final skips.
  await db
    .update(expansionCandidates)
    .set({ status: "pending", updatedAt: new Date() })
    .where(
      and(
        eq(expansionCandidates.runId, run.id),
        eq(expansionCandidates.status, "failed"),
        lt(expansionCandidates.attempts, EXPANSION.MAX_ATTEMPTS),
      ),
    );
  await db
    .update(expansionCandidates)
    .set({ status: "skipped", skipReason: sql`'failed after ' || attempts || ' attempts: ' || coalesce(skip_reason, 'unknown error')`, updatedAt: new Date() })
    .where(and(eq(expansionCandidates.runId, run.id), eq(expansionCandidates.status, "failed")));

  if (capacity <= 0) return [];
  const picked = await db
    .select()
    .from(expansionCandidates)
    .where(
      and(
        eq(expansionCandidates.runId, run.id),
        eq(expansionCandidates.status, "pending"),
        eq(expansionCandidates.eligible, true),
      ),
    )
    .orderBy(desc(expansionCandidates.score), asc(expansionCandidates.s2PaperId))
    .limit(capacity);
  if (picked.length) {
    await db
      .update(expansionCandidates)
      .set({ status: "selected", selectedWave: wave, updatedAt: new Date() })
      .where(inArray(expansionCandidates.id, picked.map((c) => c.id)));
  }
  return picked.map((c) => ({ ...c, status: "selected", selectedWave: wave }));
}

// A candidate must resolve to a REAL ingestable source: its arXiv record, or an
// open-access full text / PDF found via its DOI on OpenAlex. A paywalled
// landing page is not an ingestable source; skip and report.
export async function resolveSourceUrl(c: ExpansionCandidate): Promise<{ url: string } | { skip: string }> {
  if (c.sourceUrl) return { url: c.sourceUrl }; // checkpointed from a prior attempt
  if (c.arxivId) return { url: `https://arxiv.org/abs/${c.arxivId}` };
  if (c.doi) {
    const byDoi = await getWorkByDoi(c.doi);
    if (byDoi?.openalexId) {
      const w = await getWork(byDoi.openalexId);
      const url = w?.arxivAbsUrl ?? w?.oaUrl ?? w?.pdfUrl ?? null;
      if (url) return { url };
    }
    return { skip: "no open-access source for DOI" };
  }
  return { skip: "no arXiv id or DOI" };
}

type LibraryVotes = { assign: (linked: string[]) => string | null; nameOf: (id: string) => string };

// The candidate's linked corpus papers vote with their library memberships
// ("general" excluded). Assign only on a clear majority; never force a fit.
export async function buildLibraryVoter(): Promise<LibraryVotes> {
  const libs = await db.select({ id: libraries.id, name: libraries.name }).from(libraries);
  const names = new Map(libs.map((l) => [l.id, l.name]));
  const generalId = libs.find((l) => l.name === "general")?.id ?? null;
  const memberships = await db
    .select({ paperId: paperLibraries.paperId, libraryId: paperLibraries.libraryId })
    .from(paperLibraries);
  const byPaper = new Map<string, string[]>();
  for (const m of memberships) {
    if (m.libraryId === generalId) continue;
    const arr = byPaper.get(m.paperId) ?? [];
    arr.push(m.libraryId);
    byPaper.set(m.paperId, arr);
  }
  return {
    nameOf: (id) => names.get(id) ?? id.slice(0, 8),
    assign: (linked) => {
      const votes = new Map<string, number>();
      let total = 0;
      for (const pid of linked) {
        for (const lib of byPaper.get(pid) ?? []) {
          votes.set(lib, (votes.get(lib) ?? 0) + 1);
          total++;
        }
      }
      if (total === 0) return null;
      const ranked = [...votes.entries()].sort(
        (a, b) => b[1] - a[1] || (names.get(a[0]) ?? "").localeCompare(names.get(b[0]) ?? ""),
      );
      const [topLib, topVotes] = ranked[0];
      if (topVotes >= EXPANSION.ASSIGN_MIN_LINKS && topVotes / total >= EXPANSION.ASSIGN_MIN_SHARE) return topLib;
      return null;
    },
  };
}

// -- per-paper ingestion (transactional, verified, compensated) ----------------

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    }),
  ]);
}

async function hasEmbeddings(paperId: string): Promise<boolean> {
  const [row] = await db.select({ id: embeddings.id }).from(embeddings).where(eq(embeddings.paperId, paperId)).limit(1);
  return !!row;
}

export type IngestOutcome =
  | { kind: "ingested"; paperId: string; library: string | null }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string; authFailure: boolean; transient: boolean };

// Run the EXISTING full pipeline for one candidate. A paper counts as ingested
// only when extraction, embedding, and library linkage all landed; a paper
// that reaches the database without embeddings is deleted again (cascade) and
// the candidate marked retryable. No partial papers survive.
export async function ingestCandidate(
  run: ExpansionRun,
  c: ExpansionCandidate,
  voter: LibraryVotes,
): Promise<IngestOutcome> {
  await db
    .update(expansionCandidates)
    .set({ attempts: c.attempts + 1, updatedAt: new Date() })
    .where(eq(expansionCandidates.id, c.id));

  const src = await resolveSourceUrl(c);
  if ("skip" in src) {
    await db
      .update(expansionCandidates)
      .set({ status: "skipped", skipReason: src.skip, updatedAt: new Date() })
      .where(eq(expansionCandidates.id, c.id));
    return { kind: "skipped", reason: src.skip };
  }
  const libraryId = voter.assign(c.linkedPaperIds);
  await db
    .update(expansionCandidates)
    .set({ sourceUrl: src.url, assignedLibraryId: libraryId, updatedAt: new Date() })
    .where(eq(expansionCandidates.id, c.id));

  try {
    const result = await withTimeout(
      ingestPaper(src.url, libraryId ?? undefined),
      EXPANSION.PER_PAPER_TIMEOUT_MS,
      `ingest ${short(c.title, 60)}`,
    );

    if (result.alreadyIngested) {
      // Either a duplicate that slipped identity matching, or our own paper
      // from a timed-out attempt that completed after all. Distinguish by
      // ingest time relative to the run; both leave the corpus consistent.
      const [row] = await db
        .select({ ingestedAt: papers.ingestedAt })
        .from(papers)
        .where(eq(papers.id, result.paperId))
        .limit(1);
      // Recovery applies only when THIS candidate had a prior attempt (the
      // timed-out-but-completed case). A first-attempt hit on an existing
      // paper is the same paper under a different Semantic Scholar record:
      // a duplicate, not an ingest (the corpus paper count is the truth).
      const oursAndVerified =
        c.attempts >= 1 && row && row.ingestedAt > run.createdAt && (await hasEmbeddings(result.paperId));
      if (oursAndVerified) {
        await db
          .update(expansionCandidates)
          .set({ status: "ingested", paperId: result.paperId, skipReason: "recovered: prior attempt had completed", updatedAt: new Date() })
          .where(eq(expansionCandidates.id, c.id));
        await db
          .insert(expansionFrontier)
          .values({ runId: run.id, paperId: result.paperId, joinedWave: c.selectedWave ?? 0 })
          .onConflictDoNothing();
        return { kind: "ingested", paperId: result.paperId, library: libraryId ? voter.nameOf(libraryId) : null };
      }
      const reason = "duplicate: already in corpus";
      await db
        .update(expansionCandidates)
        .set({ status: "skipped", skipReason: reason, paperId: result.paperId, updatedAt: new Date() })
        .where(eq(expansionCandidates.id, c.id));
      return { kind: "skipped", reason };
    }

    // Verification: the paper must actually carry embeddings. If the embedding
    // step failed inside the pipeline, delete the paper (cascade removes
    // extraction/claims/links) and mark the candidate retryable.
    if (!(await hasEmbeddings(result.paperId))) {
      await db.delete(papers).where(eq(papers.id, result.paperId));
      throw new Error("embedding verification failed; paper rolled back");
    }

    await db
      .update(expansionCandidates)
      .set({ status: "ingested", paperId: result.paperId, skipReason: null, updatedAt: new Date() })
      .where(eq(expansionCandidates.id, c.id));
    // New corpus ground: this paper feeds the next wave's discovery.
    await db
      .insert(expansionFrontier)
      .values({ runId: run.id, paperId: result.paperId, joinedWave: c.selectedWave ?? 0 })
      .onConflictDoNothing();
    return { kind: "ingested", paperId: result.paperId, library: libraryId ? voter.nameOf(libraryId) : null };
  } catch (e) {
    const msg = short((e as Error).message, 280);
    const transient = isTransientNetworkError(e);
    // A network-caused failure does not burn an attempt: restore the counter
    // so an outage can never permanently skip a good candidate.
    await db
      .update(expansionCandidates)
      .set({ status: "failed", skipReason: msg, updatedAt: new Date(), ...(transient ? { attempts: c.attempts } : {}) })
      .where(eq(expansionCandidates.id, c.id));
    return { kind: "failed", reason: msg, authFailure: AUTH_FAILURE_RE.test(msg), transient };
  }
}

// -- the wave loop -------------------------------------------------------------

export type ExpansionStopReason =
  | "target_reached"
  | "pool_exhausted"
  | "auth_failures"
  | "max_waves"
  | "paper_cap";

export type ExpansionSummary = {
  runId: string;
  stopReason: ExpansionStopReason;
  ingestedThisInvocation: number;
  wavesRun: number;
};

export type RunOptions = {
  overrides?: RunOverrides;
  maxWaves?: number; // invocation-level cap (resumability testing)
  maxPapers?: number; // invocation-level cap on ingested papers
  discoverOnly?: boolean;
  log?: (m: string) => void;
};

async function countIngested(runId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(expansionCandidates)
    .where(and(eq(expansionCandidates.runId, runId), eq(expansionCandidates.status, "ingested")));
  return row.n;
}

export async function runExpansion(opts: RunOptions = {}): Promise<ExpansionSummary> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { run, resumed } = await getOrCreateRun(opts.overrides);
  log(`${resumed ? "RESUMING" : "STARTING"} expansion run ${run.id} (target ${run.targetNew} new, wave size ${run.waveSize}, corpus at start ${run.corpusSizeStart})`);

  let consecutiveAuthFailures = 0;
  let ingestedThisInvocation = 0;
  let wavesRun = 0;
  let stopReason: ExpansionStopReason = "max_waves";

  // currentWave is maintained transactionally inside the loop; finish only
  // records the terminal status and note.
  const finish = async (status: string, note: string) => {
    await db
      .update(expansionRuns)
      .set({ status, notes: note, updatedAt: new Date() })
      .where(eq(expansionRuns.id, run.id));
  };

  // Transient network failures (DNS loss, resets) retry the SAME wave after a
  // backoff instead of exiting: every step inside a wave is checkpointed and
  // re-entrant, so re-entering is always safe.
  let netRetries = 0;
  let wave = run.currentWave;
  while (wave < EXPANSION.MAX_WAVES) {
    if (opts.maxWaves !== undefined && wavesRun >= opts.maxWaves) break;
    try {
      // 1. Discovery over every pending frontier paper (wave 0: whole corpus).
      await discoverPending(run, log);

      // 2. The relevance bar, against the refreshed field distribution.
      const dist = await computeFieldDistribution(run.id);
      await evaluatePending(run, dist, log);

      if (opts.discoverOnly) {
        stopReason = "paper_cap";
        break;
      }

      // 3. Capacity from the ceiling and any invocation cap.
      const already = await countIngested(run.id);
      let capacity = run.targetNew - already;
      if (opts.maxPapers !== undefined) capacity = Math.min(capacity, opts.maxPapers - ingestedThisInvocation);
      if (capacity <= 0) {
        stopReason = opts.maxPapers !== undefined && run.targetNew - already > 0 ? "paper_cap" : "target_reached";
        break;
      }

      // 4. Deterministic selection.
      const picked = await selectWave(run, wave, Math.min(capacity, run.waveSize));
      if (picked.length === 0) {
        stopReason = "pool_exhausted";
        break;
      }
      log(`wave ${wave}: selected ${picked.length} candidates (ingested so far ${already}/${run.targetNew})`);

      // 5. Ingest with a small worker pool.
      const voter = await buildLibraryVoter();
      const queue = [...picked];
      let waveIngested = 0;
      let consecutiveNetFailures = 0;
      let stopAuth = false;
      let pauseNet = false;
      const worker = async () => {
        while (!stopAuth && !pauseNet) {
          const c = queue.shift();
          if (!c) return;
          const r = await ingestCandidate(run, c, voter);
          if (r.kind === "ingested") {
            consecutiveAuthFailures = 0;
            consecutiveNetFailures = 0;
            waveIngested++;
            ingestedThisInvocation++;
            log(`  + [${waveIngested}] ${short(c.title, 80)}${r.library ? ` -> ${r.library}` : " (corpus-only)"}`);
          } else if (r.kind === "skipped") {
            log(`  - skip ${short(c.title, 70)}: ${r.reason}`);
          } else {
            log(`  ! fail ${short(c.title, 70)}: ${r.reason}`);
            if (r.authFailure) {
              consecutiveAuthFailures++;
              if (consecutiveAuthFailures >= EXPANSION.CONSECUTIVE_AUTH_FAILURES_STOP) stopAuth = true;
            } else if (r.transient) {
              consecutiveNetFailures++;
              if (consecutiveNetFailures >= EXPANSION.CONSECUTIVE_NETWORK_FAILURES_PAUSE) pauseNet = true;
            } else {
              consecutiveAuthFailures = 0;
              consecutiveNetFailures = 0;
            }
          }
        }
      };
      await Promise.all(Array.from({ length: EXPANSION.INGEST_CONCURRENCY }, worker));

      if (stopAuth) {
        stopReason = "auth_failures";
        await finish("stopped", `stopped cleanly after ${EXPANSION.CONSECUTIVE_AUTH_FAILURES_STOP} consecutive auth/credit failures; resumable`);
        log("STOPPED CLEANLY: repeated auth/credit failures. Fix the key or credits and rerun; the checkpoint resumes exactly here.");
        return { runId: run.id, stopReason, ingestedThisInvocation, wavesRun };
      }
      if (pauseNet) throw new Error("wave paused: repeated transient network failures (ENOTFOUND)");

      wavesRun++;
      wave++;
      netRetries = 0;
      await db
        .update(expansionRuns)
        .set({ currentWave: wave, updatedAt: new Date() })
        .where(eq(expansionRuns.id, run.id));

      if (opts.maxPapers !== undefined && ingestedThisInvocation >= opts.maxPapers) {
        stopReason = "paper_cap";
        break;
      }
    } catch (e) {
      if (!isTransientNetworkError(e) || netRetries >= EXPANSION.NETWORK_RETRY_MAX) throw e;
      netRetries++;
      log(`network trouble (${short((e as Error).message, 90)}); backing off ${EXPANSION.NETWORK_BACKOFF_MS / 1000}s and retrying wave ${wave} (${netRetries}/${EXPANSION.NETWORK_RETRY_MAX})`);
      await pause(EXPANSION.NETWORK_BACKOFF_MS);
    }
  }

  const total = await countIngested(run.id);
  if (stopReason === "target_reached" || total >= run.targetNew) {
    stopReason = "target_reached";
    await finish("completed", `target reached: ${total} ingested`);
  } else if (stopReason === "pool_exhausted") {
    await finish("completed", `pool exhausted below target: ${total}/${run.targetNew} ingested (honest shortfall, bar not lowered)`);
  } else {
    // paper_cap / max_waves / discover-only: resumable pause, not an end state.
    await finish("stopped", `paused (${stopReason}): ${total}/${run.targetNew} ingested; rerun to continue`);
  }
  return { runId: run.id, stopReason, ingestedThisInvocation, wavesRun };
}

// -- reporting -----------------------------------------------------------------

export type ExpansionReport = {
  run: ExpansionRun;
  corpusNow: number;
  ingested: number;
  skippedByReason: Record<string, number>;
  candidatesTotal: number;
  eligiblePending: number;
  ineligibleByReason: Record<string, number>;
  libraryGrowth: { name: string; before: number; after: number }[];
  corpusOnlyIngested: number;
};

function bucket(reason: string | null): string {
  const r = reason ?? "unknown";
  if (/duplicate/.test(r)) return "duplicate";
  if (/no open-access|no arXiv id/.test(r)) return "unresolvable source";
  if (/failed after/.test(r)) return "ingest failure (retries exhausted)";
  return short(r, 60);
}

export async function expansionReport(runId: string): Promise<ExpansionReport | null> {
  const [run] = await db.select().from(expansionRuns).where(eq(expansionRuns.id, runId)).limit(1);
  if (!run) return null;
  const cands = await db.select().from(expansionCandidates).where(eq(expansionCandidates.runId, runId));
  const [{ n: corpusNow }] = await db.select({ n: sql<number>`count(*)::int` }).from(papers);
  const libCounts = await db
    .select({ name: libraries.name, n: sql<number>`count(${paperLibraries.paperId})::int` })
    .from(libraries)
    .leftJoin(paperLibraries, eq(paperLibraries.libraryId, libraries.id))
    .groupBy(libraries.name);

  const skippedByReason: Record<string, number> = {};
  const ineligibleByReason: Record<string, number> = {};
  let ingested = 0;
  let eligiblePending = 0;
  let corpusOnlyIngested = 0;
  for (const c of cands) {
    if (c.status === "ingested") {
      ingested++;
      if (!c.assignedLibraryId) corpusOnlyIngested++;
    } else if (c.status === "skipped" || c.status === "failed") {
      const b = bucket(c.skipReason);
      skippedByReason[b] = (skippedByReason[b] ?? 0) + 1;
    } else if (c.eligible) {
      eligiblePending++;
    } else if (c.ineligibleReason) {
      const b = bucket(c.ineligibleReason);
      ineligibleByReason[b] = (ineligibleByReason[b] ?? 0) + 1;
    }
  }

  const before = (run.libraryCountsStart ?? {}) as Record<string, number>;
  const libraryGrowth = libCounts
    .map((l) => ({ name: l.name, before: before[l.name] ?? 0, after: l.n }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    run,
    corpusNow,
    ingested,
    skippedByReason,
    candidatesTotal: cands.length,
    eligiblePending,
    ineligibleByReason,
    libraryGrowth,
    corpusOnlyIngested,
  };
}
