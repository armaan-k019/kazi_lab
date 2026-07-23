import Anthropic from "@anthropic-ai/sdk";
import { desc, eq, inArray } from "drizzle-orm";
import {
  assembleLibrary,
  extractJsonObject,
  resolveEvidenceRef,
  runCrossDomainCritique,
  type LibraryAssembly,
} from "@kazi-lab/lab";
import { groundAnalogy } from "@kazi-lab/scribe";
import {
  claims as claimsTable,
  crossDomainLinkEvidence,
  crossDomainLinks,
  crossDomainRuns,
  db,
  isAllPapersLibrary,
  libraries,
  MODELS,
  paperLibraries,
  webBridges,
  webBuildRuns,
} from "@kazi-lab/db";

const MODEL = MODELS.judgment;
const MAX_CANDIDATES = 14; // top ABC candidates shown to the proposer
const MAX_TOKENS = 12_000;
// External enrichment is best-effort: per-call timeout and bounded retries. A
// grounding failure NEVER blocks a proposal; it is recorded as unavailable.
const GROUNDING_TIMEOUT_MS = 5_000;
const GROUNDING_RETRIES = 1; // retry attempts after the first try
const SERVICE_PROBE_TIMEOUT_MS = 4_000;

// ---------------------------------------------------------------------------
// DIAGNOSTICS: every stage records what happened and why. An opaque abort is
// the bug this structure exists to prevent.
// ---------------------------------------------------------------------------
export type ProposeStage =
  | "select_run"
  | "candidates"
  | "grounding_prep"
  | "proposer_llm"
  | "grounding"
  | "persist"
  | "auto_critique";

export type ServiceName = "conceptnet" | "datamuse" | "crossref" | "semantic_scholar";
export type ServiceStatus = {
  service: ServiceName;
  status: "ok" | "degraded" | "unavailable" | "not_used";
  reason: string;
};

export type ProposeDiagnostics = {
  webRunId: string | null;
  stages: { stage: ProposeStage; status: "ok" | "failed" | "short_circuit"; note: string | null }[];
  candidatesConsidered: number;
  // Proposals returned by the model before deterministic grounding.
  proposalsFromModel: number;
  // Deterministic drops with reasons (ungrounded, outside evidence, malformed).
  dropped: { reason: string; count: number }[];
  services: ServiceStatus[];
  critique: "completed" | "skipped_no_links" | "failed" | "not_run";
  critiqueNote: string | null;
};

export type ProposeResult =
  | { status: "nothing"; reason: string; diagnostics: ProposeDiagnostics }
  | { status: "failed"; stage: ProposeStage; reason: string; diagnostics: ProposeDiagnostics }
  | {
      status: "completed";
      webRunId: string;
      crossDomainRunId: string | null;
      proposed: number;
      droppedNoGrounding: number;
      critique: { confirmed: number; promoted: number; demoted: number; rejected: number } | null;
      note: string | null;
      diagnostics: ProposeDiagnostics;
    };

type AbcPayload = {
  a_node: string;
  a_label: string;
  c_node: string;
  c_label: string;
  a_community?: number;
  c_community?: number;
  path_evidence?: {
    b_label: string;
    a_leg_papers: { id: string; title: string }[];
    c_leg_papers: { id: string; title: string }[];
  }[];
};

const SYSTEM_PROMPT = `You are the crossover proposer for kazi-lab's research web. This is literature-based discovery: Swanson's ABC model (A relates to B in one literature, B relates to C in a disjoint literature, no direct A-C link, so A-C is a candidate hypothesis) combined with Gentner's structure mapping (map RELATIONAL structure across domains, not surface vocabulary). You are CONSERVATIVE: the failure mode is manufacturing connections, so prefer proposing NOTHING over a stretch.

For each ABC candidate you deem worth proposing (you may propose none), produce a STRUCTURE-MAPPED crossover hypothesis:
- mapping: state the relational mapping explicitly, e.g. "X plays role R in community P :: Y plays role R in community Q". The roles must be RELATIONAL (what the thing does in a system), not shared words.
- why_structural: explain why this is a structural correspondence, not a surface vocabulary coincidence or a near-universal truism. If it is only surface, DO NOT propose it.
- claim_to_test: the specific claim an experiment would test.
- cite at least 2 papers on EACH side, drawn ONLY from the candidate's path evidence paper ids.

Return ONLY valid JSON:
{ "proposals": [ { "candidate_index": 0, "mapping": "...", "why_structural": "...", "claim_to_test": "...", "a_papers": ["<paper id>", ...], "c_papers": ["<paper id>", ...] } ] }
If nothing meets the bar, return { "proposals": [] }.`;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Local fetch-with-timeout for the informational service probes (kept local so
// this module adds no new dependency surface).
async function fetchTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Informational per-service health probes for the diagnostics panel. Purely
// best-effort: a probe failure never affects the pipeline. ConceptNet's probe
// result is later overridden by ACTUAL grounding outcomes when grounding runs.
async function probeServices(): Promise<ServiceStatus[]> {
  const targets: { service: ServiceName; url: string }[] = [
    { service: "conceptnet", url: `${process.env.CONCEPTNET_BASE_URL || "https://api.conceptnet.io"}/c/en/graph?limit=1` },
    { service: "datamuse", url: "https://api.datamuse.com/words?ml=graph&max=1" },
    { service: "crossref", url: "https://api.crossref.org/works?rows=1&query=science" },
    { service: "semantic_scholar", url: "https://api.semanticscholar.org/graph/v1/paper/search?query=graph&limit=1" },
  ];
  return Promise.all(
    targets.map(async (t): Promise<ServiceStatus> => {
      try {
        const res = await fetchTimeout(t.url, SERVICE_PROBE_TIMEOUT_MS);
        if (res.ok) return { service: t.service, status: "ok", reason: "probe succeeded" };
        if (res.status === 429) return { service: t.service, status: "degraded", reason: "rate-limited (HTTP 429)" };
        return { service: t.service, status: "degraded", reason: `probe returned HTTP ${res.status}` };
      } catch (e) {
        const m = errMessage(e);
        return { service: t.service, status: "unavailable", reason: m.includes("abort") ? `probe timed out after ${SERVICE_PROBE_TIMEOUT_MS / 1000}s` : `probe failed: ${m.slice(0, 120)}` };
      }
    }),
  );
}

type Grounding = { grounded: boolean; kind: string; path: string[]; note: string };

// Best-effort ConceptNet grounding: per-call timeout, bounded retries, and on
// failure the proposal proceeds with grounding recorded as unavailable. This
// call can never throw and never blocks the pipeline beyond its timeout.
async function groundAnalogyBestEffort(a: string, c: string): Promise<Grounding> {
  for (let attempt = 0; attempt <= GROUNDING_RETRIES; attempt++) {
    try {
      const result = await Promise.race<Grounding | "timeout">([
        groundAnalogy(a, c),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), GROUNDING_TIMEOUT_MS)),
      ]);
      if (result !== "timeout") return result;
    } catch (e) {
      if (attempt === GROUNDING_RETRIES) {
        return { grounded: false, kind: "unavailable", path: [], note: `ConceptNet grounding unavailable (${errMessage(e).slice(0, 100)}); proposal proceeds ungrounded.` };
      }
    }
  }
  return { grounded: false, kind: "unavailable", path: [], note: `ConceptNet grounding timed out after ${GROUNDING_TIMEOUT_MS / 1000}s; proposal proceeds ungrounded.` };
}

// Turn the research web's top ABC candidates into conservative, structure-mapped
// crossover proposals and hand them to the EXISTING cross-domain pipeline as
// candidates (source = web_discovery), so the existing Critic can audit them.
//
// Every stage is individually guarded. Empty or degenerate inputs short-circuit
// to an honest "nothing" result WITHOUT an LLM call. A failure in any stage
// produces an explicit failed result naming the stage and the real reason.
export async function proposeCrossovers(
  webRunId?: string,
  opts: { autoAudit?: boolean } = {},
): Promise<ProposeResult> {
  const autoAudit = opts.autoAudit ?? true;

  const diagnostics: ProposeDiagnostics = {
    webRunId: null,
    stages: [],
    candidatesConsidered: 0,
    proposalsFromModel: 0,
    dropped: [],
    services: [],
    critique: "not_run",
    critiqueNote: null,
  };
  const stage = (s: ProposeStage, status: "ok" | "failed" | "short_circuit", note: string | null = null) => {
    diagnostics.stages.push({ stage: s, status, note });
  };
  const addDrop = (reason: string, count = 1) => {
    const existing = diagnostics.dropped.find((d) => d.reason === reason);
    if (existing) existing.count += count;
    else diagnostics.dropped.push({ reason, count });
  };

  // Informational service probes for the diagnostics panel (parallel with the
  // pipeline's early db work; never blocks or throws).
  const probesPromise = probeServices().catch(() => [] as ServiceStatus[]);

  // -------------------------------------------------------------------------
  // STAGE: select_run
  // -------------------------------------------------------------------------
  let run: { id: string; status: string } | undefined;
  try {
    [run] = webRunId
      ? await db.select({ id: webBuildRuns.id, status: webBuildRuns.status }).from(webBuildRuns).where(eq(webBuildRuns.id, webRunId)).limit(1)
      : await db.select({ id: webBuildRuns.id, status: webBuildRuns.status }).from(webBuildRuns).where(eq(webBuildRuns.status, "completed")).orderBy(desc(webBuildRuns.completedAt)).limit(1);
  } catch (e) {
    stage("select_run", "failed", errMessage(e));
    diagnostics.services = await probesPromise;
    return { status: "failed", stage: "select_run", reason: `Could not load the web build run: ${errMessage(e)}`, diagnostics };
  }
  if (!run || run.status !== "completed") {
    stage("select_run", "short_circuit", "no completed web build");
    diagnostics.services = await probesPromise;
    return { status: "nothing", reason: "No completed web build to propose from. Build the web first.", diagnostics };
  }
  diagnostics.webRunId = run.id;
  stage("select_run", "ok", `web run ${run.id}`);

  // -------------------------------------------------------------------------
  // STAGE: candidates (deterministic assembly; zero candidates short-circuits
  // cleanly, no LLM call)
  // -------------------------------------------------------------------------
  let candidates: AbcPayload[];
  try {
    const abcOnly = (await db.select().from(webBridges).where(eq(webBridges.runId, run.id)))
      .filter((b) => b.kind === "abc")
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CANDIDATES);
    candidates = abcOnly.map((b) => b.payload as AbcPayload);
  } catch (e) {
    stage("candidates", "failed", errMessage(e));
    diagnostics.services = await probesPromise;
    return { status: "failed", stage: "candidates", reason: `Could not load ABC candidates: ${errMessage(e)}`, diagnostics };
  }
  diagnostics.candidatesConsidered = candidates.length;
  if (candidates.length === 0) {
    stage("candidates", "short_circuit", "zero ABC candidates in this build");
    diagnostics.services = await probesPromise;
    return { status: "nothing", reason: "This web build produced no ABC candidates to propose from.", diagnostics };
  }
  stage("candidates", "ok", `${candidates.length} ABC candidates`);

  // -------------------------------------------------------------------------
  // STAGE: grounding_prep (assemblies + claims + memberships). If NO candidate
  // paper can possibly ground (no synthesized library covers them), we
  // short-circuit honestly WITHOUT an LLM call: every proposal would be dropped
  // at the >=2-evidence bar anyway.
  // -------------------------------------------------------------------------
  const assemblies = new Map<string, LibraryAssembly>();
  const claimsByPaper = new Map<string, { id: string; text: string }[]>();
  const libsByPaper = new Map<string, string[]>();
  try {
    const libRows = await db.select({ id: libraries.id, name: libraries.name }).from(libraries);
    for (const l of libRows) {
      if (isAllPapersLibrary(l.name)) continue;
      const a = await assembleLibrary(l);
      if (a) assemblies.set(l.id, a);
    }
    const candidatePaperIds = new Set<string>();
    for (const c of candidates) {
      for (const pth of c.path_evidence ?? []) {
        for (const p of pth.a_leg_papers) candidatePaperIds.add(p.id);
        for (const p of pth.c_leg_papers) candidatePaperIds.add(p.id);
      }
    }
    const paperIdList = [...candidatePaperIds];
    if (paperIdList.length) {
      const claimRows = await db.select({ id: claimsTable.id, paperId: claimsTable.paperId, text: claimsTable.text }).from(claimsTable).where(inArray(claimsTable.paperId, paperIdList));
      for (const c of claimRows) {
        const arr = claimsByPaper.get(c.paperId) ?? [];
        arr.push({ id: c.id, text: c.text });
        claimsByPaper.set(c.paperId, arr);
      }
      const plRows = await db.select({ paperId: paperLibraries.paperId, libraryId: paperLibraries.libraryId }).from(paperLibraries).where(inArray(paperLibraries.paperId, paperIdList));
      for (const r of plRows) {
        const arr = libsByPaper.get(r.paperId) ?? [];
        arr.push(r.libraryId);
        libsByPaper.set(r.paperId, arr);
      }
    }
  } catch (e) {
    stage("grounding_prep", "failed", errMessage(e));
    diagnostics.services = await probesPromise;
    return { status: "failed", stage: "grounding_prep", reason: `Could not assemble grounding context: ${errMessage(e)}`, diagnostics };
  }

  // Ground one paper: find a (libraryId, claim) whose claim resolves through the
  // existing resolveEvidenceRef against that library's assembly. Returns null if
  // the paper belongs to no synthesized library (honest drop). resolveEvidenceRef
  // returns { valid }; it is additionally guarded so an unexpected throw becomes
  // a droppable null, never a pipeline abort.
  const groundPaper = (paperId: string): { libraryId: string; claimId: string; excerpt: string } | null => {
    for (const libId of libsByPaper.get(paperId) ?? []) {
      const assembly = assemblies.get(libId);
      if (!assembly) continue;
      for (const claim of claimsByPaper.get(paperId) ?? []) {
        try {
          const { valid } = resolveEvidenceRef(assembly, "claim", claim.id);
          if (valid) return { libraryId: libId, claimId: claim.id, excerpt: claim.text.slice(0, 200) };
        } catch {
          // An evidence ref that throws is treated as unresolvable, not fatal.
        }
      }
    }
    return null;
  };

  // Degenerate-input short-circuit: count candidates with at least 2 groundable
  // evidence papers (the minimum for the >=2-evidence bar to be reachable).
  const groundableCache = new Map<string, boolean>();
  const isGroundable = (paperId: string): boolean => {
    const cached = groundableCache.get(paperId);
    if (cached !== undefined) return cached;
    const v = groundPaper(paperId) !== null;
    groundableCache.set(paperId, v);
    return v;
  };
  let viableCandidates = 0;
  for (const c of candidates) {
    const ids = new Set<string>();
    for (const pth of c.path_evidence ?? []) {
      for (const p of pth.a_leg_papers) ids.add(p.id);
      for (const p of pth.c_leg_papers) ids.add(p.id);
    }
    let groundable = 0;
    for (const id of ids) if (isGroundable(id)) groundable++;
    if (groundable >= 2) viableCandidates++;
    else addDrop("candidate unviable: fewer than 2 groundable evidence papers (no synthesized library covers them)");
  }
  if (viableCandidates === 0) {
    stage("grounding_prep", "short_circuit", `${assemblies.size} synthesized libraries; no candidate has 2+ groundable evidence papers`);
    diagnostics.services = await probesPromise;
    return {
      status: "nothing",
      reason:
        assemblies.size === 0
          ? "No candidates met the grounding bar: no library has a completed synthesis to ground evidence against."
          : "No candidates met the grounding bar: the ABC candidates reference papers with no synthesized-library coverage.",
      diagnostics,
    };
  }
  stage("grounding_prep", "ok", `${assemblies.size} synthesized libraries; ${viableCandidates}/${candidates.length} candidates viable`);

  // -------------------------------------------------------------------------
  // STAGE: proposer_llm (the only LLM call; failure surfaces the REAL error)
  // -------------------------------------------------------------------------
  const doc = candidates
    .map((c, i) => {
      const paths = (c.path_evidence ?? [])
        .slice(0, 4)
        .map((p) => `    via "${p.b_label}": A-side papers [${p.a_leg_papers.map((x) => x.id).join(", ")}] (${p.a_leg_papers.map((x) => x.title).join("; ")}); C-side papers [${p.c_leg_papers.map((x) => x.id).join(", ")}] (${p.c_leg_papers.map((x) => x.title).join("; ")})`)
        .join("\n");
      return `CANDIDATE ${i}: A="${c.a_label}" (community ${c.a_community}) :: C="${c.c_label}" (community ${c.c_community})\n  no direct A-C co-occurrence; ABC intermediates:\n${paths}`;
    })
    .join("\n\n");

  let proposalsRaw: { candidate_index?: number; mapping?: unknown; why_structural?: unknown; claim_to_test?: unknown; a_papers?: unknown; c_papers?: unknown }[] = [];
  try {
    const client = new Anthropic();
    const resp = await client.messages
      .stream({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages: [{ role: "user", content: `The research web surfaced these ABC crossover candidates. Propose structure-mapped hypotheses only where genuinely warranted:\n\n${doc}` }] })
      .finalMessage();
    const truncated = resp.stop_reason === "max_tokens";
    const block = resp.content.find((b) => b.type === "text");
    const raw = block && block.type === "text" ? block.text : "";
    try {
      proposalsRaw = (JSON.parse(extractJsonObject(raw)) as { proposals?: typeof proposalsRaw }).proposals ?? [];
    } catch (e) {
      const why = truncated ? `Proposer output truncated (hit ${MAX_TOKENS} tokens); nothing written.` : `Failed to parse proposer JSON: ${errMessage(e)}`;
      stage("proposer_llm", "failed", why);
      diagnostics.services = await probesPromise;
      return { status: "failed", stage: "proposer_llm", reason: why, diagnostics };
    }
  } catch (e) {
    // The real API error (auth, billing, rate limit, network) verbatim, not an
    // opaque abort. This is exactly the class of failure that was previously
    // swallowed into a generic message.
    const why = errMessage(e);
    stage("proposer_llm", "failed", why);
    diagnostics.services = await probesPromise;
    return { status: "failed", stage: "proposer_llm", reason: `Proposer model call failed: ${why}`, diagnostics };
  }
  diagnostics.proposalsFromModel = proposalsRaw.length;
  stage("proposer_llm", "ok", `model returned ${proposalsRaw.length} proposals`);

  // -------------------------------------------------------------------------
  // STAGE: grounding (deterministic). Each proposal must cite papers from its
  // candidate's evidence and resolve to >=2 valid claim evidence rows, else
  // drop with the reason recorded. ConceptNet enrichment is best-effort.
  // -------------------------------------------------------------------------
  type LinkInsert = {
    level: string;
    summary: string;
    rationale: string;
    confidence: "low" | "medium";
    libraryIds: string[];
    evidence: { libraryId: string; evidenceKind: string; evidenceRef: string; excerpt: string }[];
  };
  const links: LinkInsert[] = [];
  let droppedNoGrounding = 0;
  let conceptnetOk = 0;
  let conceptnetFailed = 0;
  try {
    for (const p of proposalsRaw) {
      const idx = typeof p.candidate_index === "number" ? p.candidate_index : -1;
      const cand = candidates[idx];
      const mapping = str(p.mapping);
      const claimToTest = str(p.claim_to_test);
      if (!cand || !mapping || !claimToTest) {
        droppedNoGrounding++;
        addDrop("proposal malformed: missing candidate index, mapping, or claim_to_test");
        continue;
      }
      // Only accept cited papers that appear in this candidate's evidence.
      const evidencePaperIds = new Set<string>();
      for (const pth of cand.path_evidence ?? []) {
        for (const x of pth.a_leg_papers) evidencePaperIds.add(x.id);
        for (const x of pth.c_leg_papers) evidencePaperIds.add(x.id);
      }
      const citedAll = [...strArray(p.a_papers), ...strArray(p.c_papers)];
      const cited = citedAll.filter((id) => evidencePaperIds.has(id));
      if (cited.length < citedAll.length) addDrop("cited paper outside the candidate's path evidence (citation ignored)", citedAll.length - cited.length);
      const evidence: LinkInsert["evidence"] = [];
      const seen = new Set<string>();
      for (const paperId of cited) {
        const g = groundPaper(paperId);
        if (g && !seen.has(g.claimId)) {
          seen.add(g.claimId);
          evidence.push({ libraryId: g.libraryId, evidenceKind: "claim", evidenceRef: g.claimId, excerpt: g.excerpt });
        }
      }
      if (evidence.length < 2) {
        droppedNoGrounding++;
        addDrop("proposal ungrounded: fewer than 2 evidence claims resolved through a synthesized library");
        continue;
      }
      // level: "method" where the mapping is a shared method node, else "concept".
      const level = cand.a_node.startsWith("method:") || cand.c_node.startsWith("method:") ? "method" : "concept";
      const libraryIds = [...new Set(evidence.map((e) => e.libraryId))];
      // ConceptNet grounding: does the analogy have a real semantic relation path?
      // Absence is recorded and lowers confidence; it never auto-rejects and
      // (best-effort) never blocks.
      const grounding = await groundAnalogyBestEffort(cand.a_label, cand.c_label);
      if (grounding.kind === "unavailable") conceptnetFailed++;
      else conceptnetOk++;
      const confidence: "low" | "medium" = grounding.grounded ? "medium" : "low";
      const rationale = `${str(p.why_structural) ?? ""} Claim to test: ${claimToTest}. ConceptNet grounding: ${grounding.note}${grounding.path.length ? ` [${grounding.path.join(" -> ")}]` : ""}.`.trim();
      links.push({ level, summary: mapping, rationale, confidence, libraryIds, evidence });
    }
  } catch (e) {
    stage("grounding", "failed", errMessage(e));
    diagnostics.services = await probesPromise;
    return { status: "failed", stage: "grounding", reason: `Grounding stage failed: ${errMessage(e)}`, diagnostics };
  }
  stage("grounding", "ok", `${links.length} grounded, ${droppedNoGrounding} dropped`);

  // Resolve service statuses: ConceptNet reflects ACTUAL grounding usage when it
  // ran; the other probes are informational (those services are exercised at
  // build/backfill time, not by this pipeline).
  diagnostics.services = await probesPromise;
  const cn = diagnostics.services.find((s) => s.service === "conceptnet");
  if (cn && conceptnetOk + conceptnetFailed > 0) {
    if (conceptnetFailed === 0) {
      cn.status = "ok";
      cn.reason = `${conceptnetOk} grounding lookups succeeded`;
    } else if (conceptnetOk > 0) {
      cn.status = "degraded";
      cn.reason = `${conceptnetOk} grounding lookups succeeded, ${conceptnetFailed} unavailable`;
    } else {
      cn.status = "unavailable";
      cn.reason = `all ${conceptnetFailed} grounding lookups unavailable (proposals proceeded ungrounded at low confidence)`;
    }
  }

  if (links.length === 0) {
    diagnostics.critique = "skipped_no_links";
    diagnostics.critiqueNote = "no links to audit";
    return {
      status: "completed",
      webRunId: run.id,
      crossDomainRunId: null,
      proposed: 0,
      droppedNoGrounding,
      critique: null,
      note: "No proposals met the grounding bar. That is an acceptable outcome for conservative discovery.",
      diagnostics,
    };
  }

  // -------------------------------------------------------------------------
  // STAGE: persist. HANDOFF: one cross_domain_run whose links are web_discovery
  // candidates, audited by the EXISTING cross-domain Critic. is_candidate +
  // source enforced.
  // -------------------------------------------------------------------------
  let cdRunId: string;
  try {
    const scope = [...new Set(links.flatMap((l) => l.libraryIds))];
    const [cdRun] = await db.insert(crossDomainRuns).values({ scope, model: MODEL, status: "completed", completedAt: new Date(), notes: `web discovery run ${run.id}` }).returning({ id: crossDomainRuns.id });
    cdRunId = cdRun.id;
    await db.transaction(async (tx) => {
      for (const l of links) {
        const [inserted] = await tx
          .insert(crossDomainLinks)
          .values({
            crossDomainRunId: cdRunId,
            level: l.level,
            summary: l.summary,
            libraryIds: l.libraryIds,
            // Confidence reflects ConceptNet grounding (medium if a relation path
            // exists, low otherwise). Never above medium for web discovery.
            confidence: l.confidence,
            // Server-side enforcement: web discovery NEVER asserts.
            isCandidate: true,
            source: "web_discovery",
            rationale: l.rationale,
          })
          .returning({ id: crossDomainLinks.id });
        await tx.insert(crossDomainLinkEvidence).values(l.evidence.map((e) => ({ linkId: inserted.id, libraryId: e.libraryId, evidenceKind: e.evidenceKind, evidenceRef: e.evidenceRef, excerpt: e.excerpt })));
      }
    });
  } catch (e) {
    stage("persist", "failed", errMessage(e));
    return { status: "failed", stage: "persist", reason: `Could not persist the proposals: ${errMessage(e)}`, diagnostics };
  }
  stage("persist", "ok", `${links.length} links written to cross_domain_run`);

  // -------------------------------------------------------------------------
  // STAGE: auto_critique (guarded; a zero-link run never reaches here, and a
  // critique failure never loses the persisted proposals)
  // -------------------------------------------------------------------------
  let critique: { confirmed: number; promoted: number; demoted: number; rejected: number } | null = null;
  let note: string | null = null;
  if (autoAudit && links.length > 0) {
    try {
      const result = await runCrossDomainCritique(cdRunId);
      if (result.status === "completed") {
        critique = result.verdicts;
        diagnostics.critique = "completed";
        stage("auto_critique", "ok", JSON.stringify(result.verdicts));
      } else {
        note = `Auto-audit did not complete: ${result.status}.`;
        diagnostics.critique = "failed";
        diagnostics.critiqueNote = note;
        stage("auto_critique", "failed", note);
      }
    } catch (e) {
      note = `Auto-audit failed (proposals still persisted): ${errMessage(e).slice(0, 160)}`;
      diagnostics.critique = "failed";
      diagnostics.critiqueNote = note;
      stage("auto_critique", "failed", note);
    }
  } else if (!autoAudit) {
    diagnostics.critique = "not_run";
    diagnostics.critiqueNote = "auto-audit disabled for this run";
  }

  return { status: "completed", webRunId: run.id, crossDomainRunId: cdRunId, proposed: links.length, droppedNoGrounding, critique, note, diagnostics };
}
