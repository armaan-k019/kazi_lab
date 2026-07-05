import Anthropic from "@anthropic-ai/sdk";
import { inArray, sql } from "drizzle-orm";
import {
  db,
  experimentSpecs,
  experimentalistRuns,
  libraries,
  MODELS,
  metaAnalyses,
  qualitativeEvidence,
} from "@kazi-lab/db";
import { assembleLibrary, extractJsonObject, type LibraryAssembly } from "@kazi-lab/lab";
import { computePools, DEFAULT_CONDITIONS, type MetricRow, type SlicePool } from "./pooling";
import { resolveInput, type InputKind } from "./resolve-input";

const MODEL = MODELS.judgment;

// Output budgets (scaled), all well under the Opus 4.8 ceiling. Truncation guard
// is the backstop on each call.
const DERIVE_MAX_TOKENS = 1_500;
const INTERPRET_BASE = 6_000;
const INTERPRET_PER_SLICE = 400;
const INTERPRET_CAP = 16_000;
const SPEC_MAX_TOKENS = 16_000;

// EXECUTION IS THE DELIBERATE NEXT LAYER. This agent designs an execution-ready
// spec but never runs anything; a future executor consumes experiment_specs.

const MAX_METHODS_SHOWN = 14;
const MAX_QUAL_FINDINGS = 15;

export type ExperimentResult =
  | { status: "failed_precondition"; reason: string }
  | {
      status: "completed";
      runId: string;
      claim: string;
      scope: string[];
      quantitativeLibraries: string[];
      qualitativeLibraries: string[];
      sliceCount: number;
      droppedSinglePaper: number;
      varianceSubsets: number;
      interpretationVerdict: string | null;
      droppedInterpretationRefs: number;
      droppedSpecRefs: number;
      notes: string | null;
    }
  | { status: "failed"; runId: string; error: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
}
function sliceKey(s: { datasetCanon: string; metricCanon: string; taskCanon: string; conditions: string }): string {
  return `${s.datasetCanon}|${s.metricCanon}|${s.taskCanon}|${s.conditions}`;
}

// Load the metric rows for a set of scope libraries, one per metric row (deduped
// by metric id even if a paper is in two scope libraries). Only rows with a
// canonical key, a method, and a numeric value are pooled.
async function loadMetricRows(scopeIds: string[]): Promise<MetricRow[]> {
  const rows = (await db.execute<{
    id: string;
    method_name: string;
    is_self: boolean | null;
    value: string;
    dataset_canon: string;
    metric_canon: string;
    task_canon: string | null;
    conditions: string | null;
    dispersion: string | null;
    paper_id: string;
    label: string;
  }>(sql`
    select distinct on (m.id)
      m.id, m.method_name, m.is_self, m.value,
      m.dataset_canon, m.metric_canon, m.task_canon, m.conditions, m.dispersion,
      m.paper_id, coalesce(p.parse_path, left(p.title, 28)) label
    from paper_metrics m
    join papers p on p.id = m.paper_id
    join paper_libraries pl on pl.paper_id = m.paper_id
    where pl.library_id in (${sql.join(scopeIds.map((id) => sql`${id}`), sql`, `)})
      and m.dataset_canon is not null and m.metric_canon is not null
      and m.method_name is not null and m.value is not null`)).rows;
  return rows
    .map((r) => {
      const value = Number(r.value);
      if (!Number.isFinite(value)) return null;
      return {
        paperId: r.paper_id,
        paperLabel: r.label,
        methodName: r.method_name,
        isSelf: !!r.is_self,
        value,
        datasetCanon: r.dataset_canon,
        metricCanon: r.metric_canon,
        taskCanon: r.task_canon ?? "",
        conditions: (r.conditions ?? "").trim() || DEFAULT_CONDITIONS,
        dispersion: r.dispersion,
      } as MetricRow;
    })
    .filter((r): r is MetricRow => r !== null);
}

// A compact, number-preserving text rendering of a computed slice for the LLM.
function sliceDoc(s: SlicePool): string {
  const rankByMethod = new Map(s.ranks.map((r) => [r.method, r]));
  const winByMethod = new Map(s.winRates.map((w) => [w.method, w]));
  const lines = s.methods.slice(0, MAX_METHODS_SHOWN).map((m) => {
    const rk = rankByMethod.get(m.method);
    const wr = winByMethod.get(m.method);
    return `    ${m.method} = ${m.pooledValue}${m.pooledFromSelf ? " (self)" : ""}${m.conflict ? " [CONFLICT]" : ""}` +
      ` | meanRank ${rk ? rk.meanRank.toFixed(2) : "-"} over ${rk?.nPapers ?? 0}p | winRate ${wr ? (wr.winRate * 100).toFixed(0) + "%" : "-"} (${wr?.wins ?? 0}-${wr?.losses ?? 0})`;
  });
  const conflictLine = s.conflicts.length
    ? `  CONFLICTS (kept distinct): ${s.conflicts.map((c) => `${c.method}=${c.values.join(" vs ")}`).join("; ")}`
    : "  CONFLICTS: none";
  const vw = s.varianceSubset
    ? `  VARIANCE-WEIGHTED SUBSET: weighted mean ${s.varianceSubset.weightedMean.toFixed(3)} over ${s.varianceSubset.contributing.length} dispersion-bearing rows.`
    : "  VARIANCE-WEIGHTED SUBSET: not eligible (<3 dispersion rows on this slice).";
  return `KEY [${sliceKey(s)}] (${s.nPapers} papers, ${s.nMethods} methods, ${s.higherIsBetter ? "higher" : "lower"}-is-better)
  pooled methods (self-preferred; best/median):
${lines.join("\n")}
${conflictLine}
${vw}`;
}

async function callJudgment(system: string, user: string, maxTokens: number, label: string): Promise<Record<string, unknown>> {
  const client = new Anthropic();
  const resp = await client.messages
    .stream({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] })
    .finalMessage();
  const truncated = resp.stop_reason === "max_tokens";
  const block = resp.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text : "";
  try {
    return JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
  } catch (e) {
    if (truncated) throw new Error(`${label} output truncated (hit ${maxTokens} tokens); JSON incomplete, nothing written.`);
    throw new Error(`Failed to parse ${label} JSON: ${(e as Error).message}`);
  }
}

const DERIVE_SYSTEM = `You pick the single most META-ANALYZABLE claim to test for a research library, given its audited-sound findings and its top cross-paper poolable metric keys (if any). A meta-analyzable claim is one the existing quantitative literature can actually bear on. If metric keys are given, prefer a claim about method performance on those keys. If not, choose the strongest testable claim from the audited-sound findings. Return ONLY JSON: { "claim": "one sentence, a specific testable claim" }.`;

const INTERPRET_SYSTEM = `You interpret a COMPUTED quantitative meta-analysis for a claim under test. The numbers were computed deterministically; you must NOT introduce any number that is not in the computed tables, and you must NOT recompute. Read the pooled tables (per dataset/metric/task/conditions slice: pooled method values, ranks, win-rates, conflicts, variance-subset) and the qualitative evidence (for libraries with no metric layer), and say what the pooled literature says about the claim.

Rules:
- verdict is one of: supports, undermines, mixed, insufficient (how the pooled evidence bears on the claim).
- Be honest about caveats: protocol/condition splits, flagged conflicts kept distinct, missing dispersion (variance-weighted random-effects is invalid corpus-wide), and libraries that degraded to qualitative evidence.
- unknowns = what the existing data genuinely cannot settle (this feeds the experiment design).
- Cite only real keys (by their [dataset|metric|task|conditions] string) and real finding ids that were provided.

Return ONLY JSON: { "verdict": "supports|undermines|mixed|insufficient", "text": "the interpretation, grounded only in the computed numbers", "caveats": ["..."], "unknowns": ["..."], "keys_cited": ["dataset|metric|task|conditions", ...], "findings_cited": ["<finding id>", ...] }.`;

const SPEC_SYSTEM = `You design a VERIFIABLE, execution-ready experiment spec to decide a claim, grounded in the meta-analysis just computed and its interpretation. You do NOT run anything; a later executor will. The design must target the SPECIFIC gap the interpretation identified (not a generic ablation template), with concrete arms drawn from the actual methods/datasets/metrics in the literature scope.

Return ONLY JSON:
{
  "title": "...",
  "objective": "the claim restated as the precise thing this experiment decides",
  "design": { "arms": ["concrete condition/ablation arms, named methods/datasets"], "held_fixed": ["variables held constant"], "procedure": "how the runs are organized" },
  "metrics": { "measured": ["..."], "datasets": ["..."], "why": "why these metrics/datasets decide the claim" },
  "confirm_criteria": "the explicit, checkable quantitative/qualitative outcome that CONFIRMS the claim",
  "refute_criteria": "the explicit, checkable outcome that REFUTES it",
  "environment": { "dependencies": ["frameworks/libraries"], "datasets": ["dataset + where it comes from"], "hardware": "assumed hardware", "scale_notes": "estimated scale/cost" },
  "verification_harness": "what gets logged and the exact pass/fail check that would be computed on a result",
  "human_decisions": ["choices this spec deliberately leaves to a human, e.g. exact hyperparameters, compute budget"],
  "limitations": "what this design cannot settle",
  "keys_cited": ["dataset|metric|task|conditions", ...],
  "findings_cited": ["<finding id>", ...]
}
Confirm/refute criteria must be explicit and checkable. Environment must be executable-detail. Do not invent numbers not present in the computed tables.`;

// Run the Experimentalist for one input. Immutable snapshot per run. Deterministic
// pooling, then LLM interpretation, then LLM spec design; transactional write.
export async function runExperiment(inputKind: InputKind, inputRef: string): Promise<ExperimentResult> {
  let resolved;
  try {
    resolved = await resolveInput(inputKind, inputRef);
  } catch (e) {
    return { status: "failed_precondition", reason: (e as Error).message };
  }
  const scopeIds = resolved.scopeLibraryIds;

  const libRows = await db
    .select({ id: libraries.id, name: libraries.name })
    .from(libraries)
    .where(inArray(libraries.id, scopeIds));
  const nameById = new Map(libRows.map((l) => [l.id, l.name]));

  // Assemble per-library material (audited-sound findings + method inventory).
  const assemblies = new Map<string, LibraryAssembly>();
  for (const l of libRows) {
    const a = await assembleLibrary(l);
    if (a) assemblies.set(l.id, a);
  }

  // DETERMINISTIC meta-analysis.
  const rows = await loadMetricRows(scopeIds);
  const { slices, droppedSinglePaper } = computePools(rows);

  // Which scope libraries contributed metric rows vs degrade to qualitative.
  const metricLibIds = new Set<string>();
  for (const l of libRows) {
    const [{ c }] = (await db.execute<{ c: number }>(sql`
      select count(*)::int c from paper_metrics m
      join paper_libraries pl on pl.paper_id = m.paper_id
      where pl.library_id = ${l.id} and m.dataset_canon is not null and m.method_name is not null`)).rows;
    if (c > 0) metricLibIds.add(l.id);
  }
  const quantitativeLibraries = libRows.filter((l) => metricLibIds.has(l.id)).map((l) => l.name);
  const qualitativeLibraries = libRows.filter((l) => !metricLibIds.has(l.id)).map((l) => l.name);

  // Qualitative evidence rows for metric-less scope libraries (audited-sound only).
  type QualRow = { libraryId: string; findingRef: string; excerpt: string; relevanceNote: string };
  const qualRows: QualRow[] = [];
  for (const l of libRows) {
    if (metricLibIds.has(l.id)) continue;
    const a = assemblies.get(l.id);
    if (!a) continue;
    const sound = a.findings.filter((f) => f.audit === "sound").slice(0, MAX_QUAL_FINDINGS);
    for (const f of sound) {
      qualRows.push({
        libraryId: l.id,
        findingRef: f.id,
        excerpt: f.statement,
        relevanceNote: `Audited-sound finding in ${l.name} (no structured metric layer yet; qualitative evidence).`,
      });
    }
  }

  // Bare-library mode: derive the claim from the audited synthesis + top keys.
  let claim = resolved.claim;
  const notes: string[] = [...resolved.warnings];
  if (!claim) {
    const onlyLib = libRows[0];
    const a = assemblies.get(onlyLib.id);
    const soundFindings = (a?.findings.filter((f) => f.audit === "sound") ?? []).slice(0, 20);
    const topKeys = slices.slice(0, 8).map((s) => sliceKey(s));
    const deriveUser = `Library: ${onlyLib.name}
Audited-sound findings:
${soundFindings.length ? soundFindings.map((f) => `- ${f.statement}`).join("\n") : "(none)"}
Top cross-paper poolable metric keys:
${topKeys.length ? topKeys.map((k) => `- ${k}`).join("\n") : "(none; no metric layer)"}`;
    const derived = await callJudgment(DERIVE_SYSTEM, deriveUser, DERIVE_MAX_TOKENS, "claim derivation");
    claim = str(derived.claim) ?? `Assess the strongest audited-sound finding in ${onlyLib.name}.`;
    notes.push("Claim derived from the library's audited synthesis (bare-library mode).");
  }

  // Create the run row up front so a failure is visible.
  const [run] = await db
    .insert(experimentalistRuns)
    .values({
      inputKind,
      inputRef,
      claim,
      scopeLibraryIds: scopeIds,
      model: MODEL,
      status: "running",
    })
    .returning({ id: experimentalistRuns.id });
  const runId = run.id;

  try {
    // Build the computed document for the LLM (numbers preserved verbatim).
    const validityStatement =
      "VARIANCE-WEIGHTING VALIDITY: corpus-wide dispersion coverage is far too sparse (~1.3%) for a variance-weighted random-effects meta-analysis; that is NOT computed as a headline result. A per-key variance-weighted mean is provided ONLY where a slice has >=3 dispersion-bearing rows, clearly labeled as a subset.";
    const quantDoc = slices.length
      ? slices.map(sliceDoc).join("\n\n")
      : "(no cross-paper poolable metric keys in scope)";
    const qualDoc = qualRows.length
      ? [...new Set(qualRows.map((q) => q.libraryId))]
          .map((lid) => {
            const name = nameById.get(lid) ?? "library";
            const fs = qualRows.filter((q) => q.libraryId === lid);
            return `LIBRARY ${name} (no metric layer yet; qualitative evidence):\n${fs.map((f) => `  FINDING ${f.findingRef}: ${f.excerpt}`).join("\n")}`;
          })
          .join("\n\n")
      : "(all scope libraries have a metric layer)";

    const claimBlock = `CLAIM UNDER TEST: ${claim}
SCOPE: ${libRows.map((l) => l.name).join(", ")}
Quantitative libraries: ${quantitativeLibraries.join(", ") || "(none)"}
Qualitative-only libraries: ${qualitativeLibraries.join(", ") || "(none)"}`;

    // --- INTERPRETATION (LLM reads computed numbers) ---------------------
    const interpretUser = `${claimBlock}

${validityStatement}

=== COMPUTED META-ANALYSIS (deterministic; do not recompute) ===
${quantDoc}

=== QUALITATIVE EVIDENCE ===
${qualDoc}`;
    const interpretTokens = Math.min(INTERPRET_BASE + slices.length * INTERPRET_PER_SLICE, INTERPRET_CAP);
    const interpRaw = await callJudgment(INTERPRET_SYSTEM, interpretUser, interpretTokens, "interpretation");

    // Ref validation: cited keys must be real computed slices; findings real.
    const sliceKeys = new Set(slices.map((s) => sliceKey(s)));
    const scopeFindingIds = new Set<string>();
    for (const a of assemblies.values()) for (const id of a.findingIds) scopeFindingIds.add(id);
    const keysCited = strArray(interpRaw.keys_cited).filter((k) => sliceKeys.has(k));
    const findingsCited = strArray(interpRaw.findings_cited).filter((f) => scopeFindingIds.has(f));
    const droppedInterpretationRefs =
      strArray(interpRaw.keys_cited).length - keysCited.length +
      (strArray(interpRaw.findings_cited).length - findingsCited.length);
    const interpretationVerdict = str(interpRaw.verdict);
    const interpretation = {
      verdict: interpretationVerdict,
      text: str(interpRaw.text),
      caveats: strArray(interpRaw.caveats),
      unknowns: strArray(interpRaw.unknowns),
      keysCited,
      findingsCited,
    };

    // --- SPEC DESIGN (LLM designs the experiment) ------------------------
    const specUser = `${claimBlock}

=== INTERPRETATION OF THE META-ANALYSIS ===
verdict: ${interpretation.verdict}
${interpretation.text ?? ""}
Caveats: ${interpretation.caveats.join(" | ") || "(none)"}
Genuinely unknown (target these): ${interpretation.unknowns.join(" | ") || "(none)"}

=== COMPUTED META-ANALYSIS (for concrete arms; do not invent numbers) ===
${quantDoc}

=== QUALITATIVE EVIDENCE ===
${qualDoc}`;
    const specRaw = await callJudgment(SPEC_SYSTEM, specUser, SPEC_MAX_TOKENS, "spec design");
    const specKeysCited = strArray(specRaw.keys_cited).filter((k) => sliceKeys.has(k));
    const specFindingsCited = strArray(specRaw.findings_cited).filter((f) => scopeFindingIds.has(f));
    const droppedSpecRefs =
      strArray(specRaw.keys_cited).length - specKeysCited.length +
      (strArray(specRaw.findings_cited).length - specFindingsCited.length);

    if (droppedInterpretationRefs) notes.push(`Dropped ${droppedInterpretationRefs} interpretation ref(s) that did not resolve.`);
    if (droppedSpecRefs) notes.push(`Dropped ${droppedSpecRefs} spec ref(s) that did not resolve.`);
    if (droppedSinglePaper) notes.push(`${droppedSinglePaper} single-paper slice(s) excluded from cross-paper pooling.`);

    // --- WRITE (transactional) -------------------------------------------
    await db.transaction(async (tx) => {
      // meta_analyses: one row per slice per pool kind.
      for (const s of slices) {
        const base = {
          runId,
          keyDataset: s.datasetCanon,
          keyMetric: s.metricCanon,
          keyTask: s.taskCanon,
          keyConditions: s.conditions,
          nMethods: s.nMethods,
          nPapers: s.nPapers,
        };
        await tx.insert(metaAnalyses).values([
          { ...base, poolKind: "best_median", computed: { higherIsBetter: s.higherIsBetter, methods: s.methods, conflicts: s.conflicts } },
          { ...base, poolKind: "rank", computed: { higherIsBetter: s.higherIsBetter, ranks: s.ranks } },
          { ...base, poolKind: "vote_count", computed: { winRates: s.winRates } },
          ...(s.varianceSubset
            ? [{ ...base, poolKind: "variance_weighted_subset", computed: s.varianceSubset as unknown as Record<string, unknown> }]
            : []),
        ]);
      }
      if (qualRows.length) {
        await tx.insert(qualitativeEvidence).values(
          qualRows.map((q) => ({ runId, libraryId: q.libraryId, findingRef: q.findingRef, excerpt: q.excerpt, relevanceNote: q.relevanceNote })),
        );
      }
      await tx.insert(experimentSpecs).values({
        runId,
        title: str(specRaw.title),
        objective: str(specRaw.objective),
        design: (specRaw.design ?? null) as Record<string, unknown> | null,
        metrics: (specRaw.metrics ?? null) as Record<string, unknown> | null,
        confirmCriteria: str(specRaw.confirm_criteria),
        refuteCriteria: str(specRaw.refute_criteria),
        environment: (specRaw.environment ?? null) as Record<string, unknown> | null,
        verificationHarness: str(specRaw.verification_harness),
        humanDecisions: strArray(specRaw.human_decisions),
        limitations: str(specRaw.limitations),
      });
      await tx
        .update(experimentalistRuns)
        .set({ status: "completed", completedAt: new Date(), interpretation, notes: notes.length ? notes.join(" ") : null })
        .where(sql`id = ${runId}`);
    });

    return {
      status: "completed",
      runId,
      claim,
      scope: libRows.map((l) => l.name),
      quantitativeLibraries,
      qualitativeLibraries,
      sliceCount: slices.length,
      droppedSinglePaper,
      varianceSubsets: slices.filter((s) => s.varianceSubset).length,
      interpretationVerdict,
      droppedInterpretationRefs,
      droppedSpecRefs,
      notes: notes.length ? notes.join(" ") : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(experimentalistRuns)
      .set({ status: "failed", completedAt: new Date(), error: message })
      .where(sql`id = ${runId}`);
    throw error;
  }
}
