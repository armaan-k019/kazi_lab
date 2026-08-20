import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  crossDomainCriticRuns,
  crossDomainLinks,
  crossDomainRuns,
  criticRuns,
  db,
  experimentalistRuns,
  isAllPapersLibrary,
  libraries,
  linkVerdicts,
  paperLibraries,
  paperMetrics,
  extractions,
  schedulerTasks,
  synthesisRuns,
  webBuildRuns,
  writerRuns,
} from "@kazi-lab/db";
import type { AgentFailure, CorpusSnapshot, CrossDomainSnapshot, LibrarySnapshot } from "./detection";

// Assemble the deterministic corpus snapshot the detection engine runs over.
// Pure reads; the snapshot is the immutable input recorded with the run.
export async function buildCorpusSnapshot(now = new Date()): Promise<CorpusSnapshot> {
  const libs = await db.select({ id: libraries.id, name: libraries.name }).from(libraries);

  // Paper counts per library.
  const paperCounts = await db
    .select({ libraryId: paperLibraries.libraryId, c: sql<number>`count(*)::int` })
    .from(paperLibraries)
    .groupBy(paperLibraries.libraryId);
  const paperCountBy = new Map(paperCounts.map((r) => [r.libraryId, r.c]));

  // All synthesis runs, newest first, grouped in memory (the table is small).
  const synthRows = await db
    .select({
      libraryId: synthesisRuns.libraryId,
      status: synthesisRuns.status,
      error: synthesisRuns.error,
      startedAt: synthesisRuns.startedAt,
      completedAt: synthesisRuns.completedAt,
    })
    .from(synthesisRuns)
    .orderBy(desc(synthesisRuns.startedAt));
  const latestCompletedBy = new Map<string, Date>();
  const lastAttemptErrorBy = new Map<string, boolean>();
  for (const r of synthRows) {
    if (!r.libraryId) continue;
    if (!lastAttemptErrorBy.has(r.libraryId)) {
      lastAttemptErrorBy.set(r.libraryId, r.status === "failed" || r.error !== null);
    }
    if (r.status === "completed" && r.completedAt && !latestCompletedBy.has(r.libraryId)) {
      latestCompletedBy.set(r.libraryId, r.completedAt);
    }
  }

  // Metric rows per library.
  const metricCounts = await db
    .execute<{ library_id: string; c: number }>(sql`
      select pl.library_id, count(*)::int c
      from paper_metrics m join paper_libraries pl on pl.paper_id = m.paper_id
      group by pl.library_id`)
    .then((r) => r.rows);
  const metricCountBy = new Map(metricCounts.map((r) => [r.library_id, r.c]));

  // Papers with key_terms per library (metric extraction's raw material).
  const keyTermCounts = await db
    .execute<{ library_id: string; c: number }>(sql`
      select pl.library_id, count(distinct pl.paper_id)::int c
      from paper_libraries pl
      join extractions e on e.paper_id = pl.paper_id
      where coalesce(array_length(e.key_terms, 1), 0) > 0
      group by pl.library_id`)
    .then((r) => r.rows);
  const keyTermCountBy = new Map(keyTermCounts.map((r) => [r.library_id, r.c]));

  // Latest completed metric-scan outcome per library, from the scheduler's own
  // task history (commandResult.metricsOutcome, recorded at execution time).
  const metricScanTasks = await db
    .select({ scope: schedulerTasks.scope, completedAt: schedulerTasks.completedAt, commandResult: schedulerTasks.commandResult })
    .from(schedulerTasks)
    .where(and(eq(schedulerTasks.kind, "extract_metrics"), eq(schedulerTasks.status, "completed")))
    .orderBy(desc(schedulerTasks.completedAt));
  const scanBy = new Map<string, { at: Date; papersProcessed: number; withMetrics: number; skipped: number }>();
  for (const t of metricScanTasks) {
    const cr = t.commandResult as { metricsOutcome?: { papersProcessed?: number; withMetrics?: number; skipped?: number } } | null;
    const o = cr?.metricsOutcome;
    if (!o || typeof o.papersProcessed !== "number" || !t.completedAt) continue;
    for (const libId of t.scope) {
      if (!scanBy.has(libId)) {
        scanBy.set(libId, {
          at: t.completedAt,
          papersProcessed: o.papersProcessed,
          withMetrics: o.withMetrics ?? 0,
          skipped: o.skipped ?? 0,
        });
      }
    }
  }

  const libSnapshots: LibrarySnapshot[] = [];
  for (const l of libs) {
    const latest = latestCompletedBy.get(l.id) ?? null;
    let papersAddedSince = 0;
    if (latest) {
      const [row] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(paperLibraries)
        .where(and(eq(paperLibraries.libraryId, l.id), gt(paperLibraries.addedAt, latest)));
      papersAddedSince = row?.c ?? 0;
    }
    libSnapshots.push({
      id: l.id,
      name: l.name,
      isAllPapers: isAllPapersLibrary(l.name),
      paperCount: paperCountBy.get(l.id) ?? 0,
      latestSynthesisAt: latest,
      lastSynthesisHadError: lastAttemptErrorBy.get(l.id) ?? false,
      papersAddedSinceSynthesis: papersAddedSince,
      papersWithKeyTerms: keyTermCountBy.get(l.id) ?? 0,
      metricRowCount: metricCountBy.get(l.id) ?? 0,
      latestMetricScan: scanBy.get(l.id) ?? null,
    });
  }

  // Latest completed cross-domain run + link/verdict state.
  let latestCrossDomain: CrossDomainSnapshot = null;
  const [cd] = await db
    .select({ id: crossDomainRuns.id, scope: crossDomainRuns.scope, completedAt: crossDomainRuns.completedAt })
    .from(crossDomainRuns)
    .where(eq(crossDomainRuns.status, "completed"))
    .orderBy(desc(crossDomainRuns.completedAt))
    .limit(1);
  if (cd?.completedAt) {
    const links = await db
      .select({ id: crossDomainLinks.id })
      .from(crossDomainLinks)
      .where(eq(crossDomainLinks.crossDomainRunId, cd.id));
    let allRejected = false;
    if (links.length > 0) {
      const [critique] = await db
        .select({ id: crossDomainCriticRuns.id })
        .from(crossDomainCriticRuns)
        .where(and(eq(crossDomainCriticRuns.crossDomainRunId, cd.id), eq(crossDomainCriticRuns.status, "completed")))
        .orderBy(desc(crossDomainCriticRuns.completedAt))
        .limit(1);
      if (critique) {
        const verdicts = await db
          .select({ linkId: linkVerdicts.linkId, verdict: linkVerdicts.verdict })
          .from(linkVerdicts)
          .where(and(eq(linkVerdicts.criticRunId, critique.id), inArray(linkVerdicts.linkId, links.map((x) => x.id))));
        const byLink = new Map(verdicts.map((v) => [v.linkId, v.verdict]));
        allRejected = links.length > 0 && links.every((l) => byLink.get(l.id) === "rejected");
      }
    }
    latestCrossDomain = {
      completedAt: cd.completedAt,
      scopeLibraryIds: cd.scope,
      linkCount: links.length,
      allLinksRejected: allRejected,
    };
  }

  // Failed agent runs in the last 24h, across every run table with a status.
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const failures: AgentFailure[] = [];
  const failedSynth = await db
    .select({ libraryId: synthesisRuns.libraryId, at: synthesisRuns.startedAt, error: synthesisRuns.error })
    .from(synthesisRuns)
    .where(and(eq(synthesisRuns.status, "failed"), gt(synthesisRuns.startedAt, since)));
  for (const f of failedSynth) failures.push({ agent: "synthesis", libraryId: f.libraryId, at: f.at, error: f.error ?? "unknown" });
  const failedCritic = await db
    .select({ libraryId: criticRuns.libraryId, at: criticRuns.createdAt, error: criticRuns.error })
    .from(criticRuns)
    .where(and(eq(criticRuns.status, "failed"), gt(criticRuns.createdAt, since)));
  for (const f of failedCritic) failures.push({ agent: "critic", libraryId: f.libraryId, at: f.at, error: f.error ?? "unknown" });
  const failedCd = await db
    .select({ at: crossDomainRuns.createdAt, error: crossDomainRuns.error })
    .from(crossDomainRuns)
    .where(and(eq(crossDomainRuns.status, "failed"), gt(crossDomainRuns.createdAt, since)));
  for (const f of failedCd) failures.push({ agent: "cross_domain", libraryId: null, at: f.at, error: f.error ?? "unknown" });
  const failedCdc = await db
    .select({ at: crossDomainCriticRuns.createdAt, error: crossDomainCriticRuns.error })
    .from(crossDomainCriticRuns)
    .where(and(eq(crossDomainCriticRuns.status, "failed"), gt(crossDomainCriticRuns.createdAt, since)));
  for (const f of failedCdc) failures.push({ agent: "cross_domain_critic", libraryId: null, at: f.at, error: f.error ?? "unknown" });
  const failedWeb = await db
    .select({ at: webBuildRuns.createdAt, error: webBuildRuns.error })
    .from(webBuildRuns)
    .where(and(eq(webBuildRuns.status, "failed"), gt(webBuildRuns.createdAt, since)));
  for (const f of failedWeb) failures.push({ agent: "web_build", libraryId: null, at: f.at, error: f.error ?? "unknown" });
  const failedExp = await db
    .select({ at: experimentalistRuns.createdAt, error: experimentalistRuns.error })
    .from(experimentalistRuns)
    .where(and(eq(experimentalistRuns.status, "failed"), gt(experimentalistRuns.createdAt, since)));
  for (const f of failedExp) failures.push({ agent: "experimentalist", libraryId: null, at: f.at, error: f.error ?? "unknown" });
  const failedWriter = await db
    .select({ at: writerRuns.createdAt, error: writerRuns.error })
    .from(writerRuns)
    .where(and(eq(writerRuns.status, "failed"), gt(writerRuns.createdAt, since)));
  for (const f of failedWriter) failures.push({ agent: "writer", libraryId: null, at: f.at, error: f.error ?? "unknown" });

  return { now, libraries: libSnapshots, latestCrossDomain, recentAgentFailures: failures };
}
