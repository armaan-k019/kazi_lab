// ---------------------------------------------------------------------------
// Detection engine: deterministic TypeScript over a corpus snapshot. No LLM,
// no I/O, no clock reads (the snapshot carries `now`), so every rule is
// unit-testable and reproducible. The scheduler proposes; it never asserts.
// ---------------------------------------------------------------------------

export type LibrarySnapshot = {
  id: string;
  name: string;
  isAllPapers: boolean;
  paperCount: number;
  // Latest COMPLETED synthesis (null when none has ever completed).
  latestSynthesisAt: Date | null;
  // True when the most recent synthesis attempt (any status) failed or
  // recorded an error.
  lastSynthesisHadError: boolean;
  // Papers linked to the library after the latest completed synthesis.
  papersAddedSinceSynthesis: number;
  // Papers in this library with at least one extraction carrying key_terms
  // (the precondition for metric extraction to have something to read).
  papersWithKeyTerms: number;
  metricRowCount: number;
  // The latest completed metric-extraction scan outcome for this library
  // (recorded by the scheduler from the CLI's METRICS_OUTCOME_JSON line).
  // A CLEAN zero scan (papers processed, nothing skipped, zero rows) is a
  // real result and must stop the scheduler from re-queuing forever.
  latestMetricScan: { at: Date; papersProcessed: number; withMetrics: number; skipped: number } | null;
};

export type CrossDomainSnapshot = {
  completedAt: Date;
  scopeLibraryIds: string[];
  linkCount: number;
  // True when the latest completed cross-domain critique rejected every link.
  allLinksRejected: boolean;
} | null;

export type AgentFailure = {
  agent: string; // synthesis | critic | cross_domain | cross_domain_critic | web_build | experimentalist | writer
  libraryId: string | null;
  at: Date;
  error: string;
};

export type CorpusSnapshot = {
  now: Date;
  libraries: LibrarySnapshot[];
  latestCrossDomain: CrossDomainSnapshot;
  // Failed agent runs inside the last 24 hours (diagnostics only, no retry
  // task in Phase 1; retry policy is deferred to human judgment).
  recentAgentFailures: AgentFailure[];
};

export type TaskKind =
  | "extract_metrics"
  | "re_synthesize"
  | "re_critique"
  | "extract_cross_domain"
  | "propose_crossovers";

export type DiagnosticKind =
  | "stale_synthesis"
  | "missing_metrics"
  | "missing_cross_domain"
  | "missing_proposals"
  | "api_failure";

export type DetectedTask = {
  kind: TaskKind;
  scope: string[]; // library ids ([] for corpus-level tasks)
  scopeNames: string[]; // resolved names, for human-readable descriptions
  priority: number; // 1-10, higher = more urgent
  reason: string;
  costEstimateUsd: number;
  costEstimateTokens: number;
  approvalRequired: boolean;
};

export type DetectedDiagnostic = {
  kind: DiagnosticKind;
  affectedLibraryId: string | null;
  details: Record<string, unknown>;
};

export type DetectionStats = {
  totalLibraries: number; // non-general libraries with papers
  synthesizedLibraries: number;
  librariesWithMetrics: number;
  synthesisStale: number; // includes never-synthesized
  metricsMissing: number;
  crossDomainMissing: number; // 0 or 1 (corpus-level)
  proposalsMissing: number; // 0 or 1
  apiFailures24h: number;
};

export type DetectionResult = {
  tasks: DetectedTask[];
  diagnostics: DetectedDiagnostic[];
  stats: DetectionStats;
};

// ---------------------------------------------------------------------------
// Priorities (spec): stale synthesis 5, missing metrics 6, missing
// cross-domain 7, missing proposals 8. Higher runs first.
// ---------------------------------------------------------------------------
export const PRIORITY: Record<TaskKind, number> = {
  re_synthesize: 5,
  extract_metrics: 6,
  extract_cross_domain: 7,
  propose_crossovers: 8,
  re_critique: 5, // no detection rule queues this in Phase 1; kept for parity
};

// ---------------------------------------------------------------------------
// Cost estimation: conservative upper bounds, stored and reported, never
// asserted as precise. USD figures follow the prompt's estimates; token
// figures are derived at a documented blended rate (~$15 per 1M tokens
// blended in/out for Opus-class calls, rounded up).
// ---------------------------------------------------------------------------
const COSTS: Record<TaskKind, { usdPerUnit: number; tokensPerUnit: number; usdCap: number | null }> = {
  // ~$0.30 per library, total capped at $5 (spec). Honest caveat, reported in
  // docs: a full first-pass extraction of a ~20-paper library with Opus-class
  // calls has historically cost more than this; the estimate is the spec's,
  // and the command result records what actually happened.
  extract_metrics: { usdPerUnit: 0.3, tokensPerUnit: 20_000, usdCap: 5 },
  re_synthesize: { usdPerUnit: 2.0, tokensPerUnit: 130_000, usdCap: null },
  re_critique: { usdPerUnit: 1.5, tokensPerUnit: 100_000, usdCap: null },
  // Cross-domain synthesis is ONE run over the whole scope (its cost grows
  // with corpus size, not linearly per library), so it is estimated per run.
  extract_cross_domain: { usdPerUnit: 3.0, tokensPerUnit: 200_000, usdCap: null },
  propose_crossovers: { usdPerUnit: 1.0, tokensPerUnit: 65_000, usdCap: null },
};

export function estimateTaskCost(kind: TaskKind, units: number): { usd: number; tokens: number } {
  const c = COSTS[kind];
  const n = Math.max(1, units);
  const usdRaw = c.usdPerUnit * n;
  const usd = c.usdCap !== null ? Math.min(usdRaw, c.usdCap) : usdRaw;
  return { usd: Math.round(usd * 100) / 100, tokens: c.tokensPerUnit * n };
}

// Only metric extraction is auto-approved (idempotent, only-missing re-runs,
// bounded cost). Everything that writes new synthesis/critique/link state
// needs a human click.
export function approvalRequiredFor(kind: TaskKind): boolean {
  return kind !== "extract_metrics";
}

const DAY_MS = 86_400_000;

function daysBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / DAY_MS;
}

// ---------------------------------------------------------------------------
// detectStaleStates: the five rules, in priority order of what they queue.
//
// Two documented deviations from the letter of the prompt, both reconciling
// its rules with its own expected output (see docs/context.md):
//  1. A library with papers and NO synthesis ever is queued re_synthesize
//     (the maximally stale state; the strict rule only covered old runs and
//     would leave such a library invisible to the scheduler forever).
//  2. missing-metrics does not require a completed synthesis, because metric
//     extraction reads papers/extractions directly and the prompt expects
//     cosmic-structure (which has no synthesis) to be flagged.
// ---------------------------------------------------------------------------
export function detectStaleStates(snapshot: CorpusSnapshot, thresholdDays = 30): DetectionResult {
  const tasks: DetectedTask[] = [];
  const diagnostics: DetectedDiagnostic[] = [];
  const { now } = snapshot;

  const real = snapshot.libraries.filter((l) => !l.isAllPapers && l.paperCount > 0);

  // Rule 1: stale (or absent) synthesis, per library.
  for (const lib of real) {
    if (lib.latestSynthesisAt === null) {
      tasks.push(makeTask("re_synthesize", [lib], `never synthesized (${lib.paperCount} papers)`));
      diagnostics.push({
        kind: "stale_synthesis",
        affectedLibraryId: lib.id,
        details: { reason: "never_synthesized", paperCount: lib.paperCount },
      });
      continue;
    }
    const ageDays = daysBetween(now, lib.latestSynthesisAt);
    if (ageDays > thresholdDays && (lib.papersAddedSinceSynthesis > 0 || lib.lastSynthesisHadError)) {
      const why =
        lib.papersAddedSinceSynthesis > 0
          ? `${lib.papersAddedSinceSynthesis} papers added since`
          : "last synthesis attempt had errors";
      tasks.push(makeTask("re_synthesize", [lib], `synthesis ${Math.floor(ageDays)}d old; ${why}`));
      diagnostics.push({
        kind: "stale_synthesis",
        affectedLibraryId: lib.id,
        details: {
          reason: "stale",
          ageDays: Math.floor(ageDays),
          papersAddedSinceSynthesis: lib.papersAddedSinceSynthesis,
          lastSynthesisHadError: lib.lastSynthesisHadError,
        },
      });
    }
  }

  // Rule 2: missing metrics, per library. A prior CLEAN zero scan (processed
  // everything, skipped nothing, found nothing) suppresses the task: that is
  // a genuine "this library has no extractable metrics" result, recorded as a
  // diagnostic instead of being re-queued forever. A scan with skips does NOT
  // suppress: those papers still owe a real attempt.
  for (const lib of real) {
    if (lib.papersWithKeyTerms > 0 && lib.metricRowCount === 0) {
      const scan = lib.latestMetricScan;
      const cleanZeroScan = scan !== null && scan.papersProcessed > 0 && scan.skipped === 0 && scan.withMetrics === 0;
      if (cleanZeroScan) {
        diagnostics.push({
          kind: "missing_metrics",
          affectedLibraryId: lib.id,
          details: {
            papersWithKeyTerms: lib.papersWithKeyTerms,
            paperCount: lib.paperCount,
            scanned: true,
            papersScanned: scan.papersProcessed,
            scannedAt: scan.at.toISOString(),
            reason: "scanned cleanly; no extractable metrics found; not re-queued",
          },
        });
        continue;
      }
      const failedScanNote = scan !== null && scan.skipped > 0 ? `; last scan skipped ${scan.skipped}/${scan.papersProcessed} papers` : "";
      tasks.push(
        makeTask("extract_metrics", [lib], `zero metric rows; ${lib.papersWithKeyTerms} papers have key terms${failedScanNote}`),
      );
      diagnostics.push({
        kind: "missing_metrics",
        affectedLibraryId: lib.id,
        details: { papersWithKeyTerms: lib.papersWithKeyTerms, paperCount: lib.paperCount },
      });
    }
  }

  // Rule 3: missing cross-domain (corpus-level; cross-domain synthesis runs
  // over the whole eligible set, so one task, not one per library).
  const synthesized = real.filter((l) => l.latestSynthesisAt !== null);
  let crossDomainMissing = 0;
  if (synthesized.length >= 2) {
    const cd = snapshot.latestCrossDomain;
    const covered = new Set(cd?.scopeLibraryIds ?? []);
    const uncovered = synthesized.filter((l) => !covered.has(l.id));
    const tooOld = cd !== null && daysBetween(now, cd.completedAt) > thresholdDays;
    if (cd === null || tooOld || uncovered.length > 0) {
      const reason =
        cd === null
          ? "no cross-domain run has ever completed"
          : tooOld
            ? `latest cross-domain run is ${Math.floor(daysBetween(now, cd.completedAt))}d old`
            : `not covered by the latest run: ${uncovered.map((l) => l.name).join(", ")}`;
      tasks.push(makeTask("extract_cross_domain", synthesized, reason));
      crossDomainMissing = 1;
      for (const lib of cd === null || tooOld ? synthesized : uncovered) {
        diagnostics.push({
          kind: "missing_cross_domain",
          affectedLibraryId: lib.id,
          details: { reason },
        });
      }
    }
  }

  // Rule 4: missing proposals on the latest completed cross-domain run.
  let proposalsMissing = 0;
  const cd = snapshot.latestCrossDomain;
  if (cd !== null && (cd.linkCount === 0 || cd.allLinksRejected)) {
    const reason = cd.linkCount === 0 ? "latest cross-domain run has zero links" : "all links on the latest run were rejected";
    tasks.push(makeTask("propose_crossovers", [], reason));
    proposalsMissing = 1;
    diagnostics.push({ kind: "missing_proposals", affectedLibraryId: null, details: { reason, linkCount: cd.linkCount } });
  }

  // Rule 5: recent agent failures. Diagnostics only; no retry task in Phase 1.
  for (const f of snapshot.recentAgentFailures) {
    diagnostics.push({
      kind: "api_failure",
      affectedLibraryId: f.libraryId,
      details: { agent: f.agent, at: f.at.toISOString(), error: f.error.slice(0, 400) },
    });
  }

  // Deterministic order: priority desc, then kind, then first scope name.
  tasks.sort(
    (a, b) =>
      b.priority - a.priority ||
      a.kind.localeCompare(b.kind) ||
      (a.scopeNames[0] ?? "").localeCompare(b.scopeNames[0] ?? ""),
  );

  const stats: DetectionStats = {
    totalLibraries: real.length,
    synthesizedLibraries: synthesized.length,
    librariesWithMetrics: real.filter((l) => l.metricRowCount > 0).length,
    synthesisStale: tasks.filter((t) => t.kind === "re_synthesize").length,
    metricsMissing: tasks.filter((t) => t.kind === "extract_metrics").length,
    crossDomainMissing,
    proposalsMissing,
    apiFailures24h: snapshot.recentAgentFailures.length,
  };

  return { tasks, diagnostics, stats };
}

function makeTask(kind: TaskKind, libs: LibrarySnapshot[], reason: string): DetectedTask {
  const units = kind === "extract_cross_domain" || kind === "propose_crossovers" ? 1 : Math.max(1, libs.length);
  const { usd, tokens } = estimateTaskCost(kind, units);
  return {
    kind,
    scope: libs.map((l) => l.id),
    scopeNames: libs.map((l) => l.name),
    priority: PRIORITY[kind],
    reason,
    costEstimateUsd: usd,
    costEstimateTokens: tokens,
    approvalRequired: approvalRequiredFor(kind),
  };
}

// Human-readable one-liner for the approval UI and CLI output.
export function describeTask(t: DetectedTask): string {
  const verb: Record<TaskKind, string> = {
    extract_metrics: "Extract metrics on",
    re_synthesize: "Re-synthesize",
    re_critique: "Re-critique",
    extract_cross_domain: "Cross-domain synthesis over",
    propose_crossovers: "Propose crossovers from the research web",
  };
  const scope = t.scopeNames.length ? ` ${t.scopeNames.join(", ")}` : "";
  const approval = t.approvalRequired ? "needs approval" : "auto-approved";
  return `${verb[t.kind]}${scope} (~$${t.costEstimateUsd.toFixed(2)}, ${approval}): ${t.reason}`;
}
