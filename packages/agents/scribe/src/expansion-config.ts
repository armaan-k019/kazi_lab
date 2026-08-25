// ---------------------------------------------------------------------------
// EXPANSION CONFIG: every constant governing the controlled corpus expansion.
// The relevance filter here is the contamination guard: a candidate enters the
// corpus ONLY through the citation graph from existing verified papers, and
// only when it clears the documented bar below. There is no keyword search
// anywhere in this pipeline. Change a threshold here and the whole run's
// behavior changes in exactly one documented place; each run also snapshots
// these values into expansion_runs.params for auditability.
// ---------------------------------------------------------------------------

export const EXPANSION = {
  // Ceiling, not a quota. If fewer candidates clear the bar and resolve to a
  // real ingestable source, the run stops early and reports the shortfall
  // honestly instead of lowering the bar.
  TARGET_NEW: 400,

  // Papers ingested per wave. After a wave lands, its papers join the frontier
  // so the next wave's discovery can expand outward from them.
  WAVE_SIZE: 50,
  // Hard stop on waves, a runaway backstop far above what TARGET_NEW needs
  // (waves also spend on retries, skips, and resumed runs, so this is
  // deliberately generous; the TARGET_NEW ceiling is the real limit).
  MAX_WAVES: 30,

  // How many references and citations to pull per frontier paper.
  NEIGHBOR_LIMIT: 100,

  // -------------------------------------------------------------------------
  // RELEVANCE BAR (the contamination guard). A candidate is ELIGIBLE only if:
  //   (a) it is linked (cites or is cited by) to at least MIN_CORPUS_LINKS
  //       DISTINCT corpus papers, AND its field fit clears FIELD_FIT_MIN
  //       (candidates with no Semantic Scholar field data need
  //       MIN_LINKS_UNKNOWN_FIELDS distinct links instead); OR
  //   (b) it has exactly one corpus link, but that edge is flagged
  //       isInfluential by Semantic Scholar AND its field fit clears the much
  //       higher FIELD_FIT_SINGLE_LINK_MIN.
  // A paper connected to a single corpus paper by a single weak edge is NEVER
  // eligible; that is exactly how off-topic drift entered before.
  //
  // fieldFit = max over the candidate's fieldsOfStudy of that field's share of
  // the resolved corpus (share = corpus papers listing the field / corpus
  // papers with any field data). 0.15 means: at least one of the candidate's
  // fields is carried by 15 percent or more of the corpus.
  // -------------------------------------------------------------------------
  MIN_CORPUS_LINKS: 2,
  MIN_LINKS_UNKNOWN_FIELDS: 3,
  FIELD_FIT_MIN: 0.15,
  FIELD_FIT_SINGLE_LINK_MIN: 0.5,

  // -------------------------------------------------------------------------
  // RANKING SCORE for eligible candidates (selection order within a wave):
  //   score = W_LINKS * min(corpusLinks, LINKS_CAP)
  //         + W_INFLUENTIAL * min(influentialLinks, INFLUENTIAL_CAP)
  //         + W_FIELD_FIT * (fieldFit, or FIELD_FIT_MIN when unknown)
  //         + W_PROMINENCE * min(1, log10(1 + citationCount) / 4)
  // Connectivity dominates (strengthen existing communities first), influence
  // and field fit refine, global prominence is a small tiebreaker capped so
  // mega-cited generic papers cannot outrank well-connected relevant ones.
  // Ties break on s2PaperId ascending: fully deterministic.
  // -------------------------------------------------------------------------
  W_LINKS: 2.0,
  LINKS_CAP: 8,
  W_INFLUENTIAL: 1.0,
  INFLUENTIAL_CAP: 4,
  W_FIELD_FIT: 3.0,
  W_PROMINENCE: 1.0,

  // -------------------------------------------------------------------------
  // LIBRARY ASSIGNMENT ("ingest everywhere", but never a forced fit). The
  // candidate's linked corpus papers vote with their library memberships
  // (the "general" catch-all is excluded from voting). Assign to the top
  // library only when it has at least ASSIGN_MIN_LINKS votes AND at least
  // ASSIGN_MIN_SHARE of all votes; otherwise the paper stays corpus-only
  // (the research web is corpus-wide, so nothing is lost).
  // -------------------------------------------------------------------------
  ASSIGN_MIN_LINKS: 2,
  ASSIGN_MIN_SHARE: 0.5,

  // -------------------------------------------------------------------------
  // EXECUTION. Per-paper ingestion runs the existing full pipeline (fetch,
  // parse, claim extraction, embedding, enrichment); INGEST_CONCURRENCY papers
  // run at once. Vision transcription stays OFF (the pipeline default) for
  // cost. Metric extraction is deliberately NOT run here; the scheduler's
  // detection flags grown libraries for a targeted later pass.
  // -------------------------------------------------------------------------
  INGEST_CONCURRENCY: 3,
  PER_PAPER_TIMEOUT_MS: 10 * 60_000,
  // A failed candidate is retried on the next wave until attempts hit this.
  MAX_ATTEMPTS: 2,
  // After this many CONSECUTIVE auth/credit failures the run stops cleanly
  // (status "stopped", fully resumable) instead of thrashing the API.
  CONSECUTIVE_AUTH_FAILURES_STOP: 3,

  // Transient NETWORK failures (DNS loss, connection resets) self-heal: the
  // current wave backs off and retries in place, because every step inside a
  // wave is checkpointed and re-entrant. Only after NETWORK_RETRY_MAX
  // consecutive backoffs does the run stop cleanly (still resumable). A
  // network-caused ingest failure never burns one of a candidate's attempts.
  NETWORK_BACKOFF_MS: 30_000,
  NETWORK_RETRY_MAX: 20,
  CONSECUTIVE_NETWORK_FAILURES_PAUSE: 3,
} as const;

// Transient network failure signatures (distinct from auth/credit failures).
export const TRANSIENT_NETWORK_RE = /ENOTFOUND|EAI_AGAIN|EADDRNOTAVAIL|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|fetch failed|Timed out fetching|Connection terminated|socket hang up/i;

// Auth/credit failure signatures that trigger the clean stop.
export const AUTH_FAILURE_RE = /401|authentication_error|invalid.*api key|credit balance|billing|insufficient.*credit/i;
