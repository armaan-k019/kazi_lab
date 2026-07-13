import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  criticAbstracts,
  criticRuns,
  crossDomainCriticRuns,
  crossDomainLinkEvidence,
  crossDomainLinks,
  db,
  experimentSpecs,
  experimentalistRuns,
  libraries,
  libraryConferences,
  linkVerdicts,
  metaAnalyses,
  MODELS,
  qualitativeEvidence,
  researchDocuments,
  writerRuns,
} from "@kazi-lab/db";
import { assembleLibrary, extractJsonObject, type LibraryAssembly } from "@kazi-lab/lab";

const MODEL = MODELS.judgment;

// The fixed section order. Every document has all of these; a section with
// nothing to say states that honestly rather than being omitted. "results" is
// generated deterministically as an honest, forward-compatible placeholder.
export const SECTION_KEYS = [
  "abstract",
  "background",
  "claim_and_origin",
  "meta_analysis",
  "proposed_experiment",
  "results",
  "limitations",
  "next_steps",
] as const;
type SectionKey = (typeof SECTION_KEYS)[number];
const HEADINGS: Record<SectionKey, string> = {
  abstract: "Abstract",
  background: "Background",
  claim_and_origin: "Claim and origin",
  meta_analysis: "Meta-analysis",
  proposed_experiment: "Proposed experiment",
  results: "Results",
  limitations: "Limitations",
  next_steps: "Next steps",
};
// The model writes every section except results (deterministic below).
const MODEL_SECTIONS = SECTION_KEYS.filter((k) => k !== "results");

const RESULTS_PLACEHOLDER =
  "Execution has not been performed. This thread PROPOSES an experiment (see Proposed experiment); the lab's execution layer does not exist yet, so there are no measured results. When that layer runs the proposed spec, this section will hold the measured outcomes, the confirm-or-refute decision computed by the verification harness, and any deviations from the plan. Until then, every statement in this document rests on the existing literature and the deterministic meta-analysis, not on new experiments.";

// Output budget: documents are long. Scale with the amount of assembled material
// (meta keys + findings), capped well under the Opus 4.8 ceiling. Truncation
// guard is the backstop.
const BASE_TOKENS = 10_000;
const PER_ITEM = 300;
const MAX_OUTPUT_CAP = 28_000;

export type Section = { key: SectionKey; heading: string; body: string; kind: string };
export type WriterResult =
  | { status: "nothing"; reason: string }
  | {
      status: "completed";
      writerRunId: string;
      documentId: string;
      title: string;
      sectionCount: number;
      droppedRefs: number;
      unverifiedNumbers: number;
      conferencesConsidered: string[];
      notes: string | null;
    }
  | { status: "failed"; writerRunId: string; error: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
}

// Render a document to clean markdown (title + sections). Shared by the CLI and
// the export route so the file and the API agree.
export function documentToMarkdown(title: string | null, sections: Section[]): string {
  const parts = [`# ${title ?? "Research document"}`];
  for (const s of sections) {
    parts.push(`\n## ${s.heading}\n\n${s.body}`);
  }
  return parts.join("\n") + "\n";
}

type MetaKeyGroup = {
  id: string; // the best_median row id (stands in as the key's citeable id)
  dataset: string | null;
  metric: string | null;
  task: string | null;
  conditions: string | null;
  nPapers: number | null;
  nMethods: number | null;
  kinds: Record<string, unknown>;
};

// Collect every measurement-like number the document is allowed to restate, so
// the meta_analysis section can be checked for fabricated figures. Decimals and
// win-rate percentages only; bare integers are skipped (they collide with
// dataset names like ModelNet40 / S3DIS and with years).
function collectComputedNumbers(keys: MetaKeyGroup[]): { decimals: number[]; percents: Set<number> } {
  const decimals: number[] = [];
  const percents = new Set<number>();
  const add = (n: unknown) => {
    if (typeof n === "number" && Number.isFinite(n)) decimals.push(n);
  };
  for (const k of keys) {
    const bm = k.kinds.best_median as { methods?: { pooledValue: number }[]; conflicts?: { values: number[] }[] } | undefined;
    for (const m of bm?.methods ?? []) add(m.pooledValue);
    for (const c of bm?.conflicts ?? []) for (const v of c.values) add(v);
    const rk = k.kinds.rank as { ranks?: { meanRank: number; medianRank: number }[] } | undefined;
    for (const r of rk?.ranks ?? []) {
      add(r.meanRank);
      add(r.medianRank);
    }
    const vc = k.kinds.vote_count as { winRates?: { winRate: number }[] } | undefined;
    for (const w of vc?.winRates ?? []) {
      add(w.winRate);
      percents.add(Math.round(w.winRate * 100));
    }
    const vw = k.kinds.variance_weighted_subset as { weightedMean?: number; contributing?: { value: number; std: number }[] } | undefined;
    if (vw?.weightedMean !== undefined) add(vw.weightedMean);
    for (const c of vw?.contributing ?? []) {
      add(c.value);
      add(c.std);
    }
  }
  return { decimals, percents };
}

// Numeric membership check for the meta_analysis section. Returns how many
// measurement-like numbers in the text do NOT appear among the computed values.
function countUnverifiedNumbers(body: string, computed: { decimals: number[]; percents: Set<number> }): number {
  let unverified = 0;
  const isDecimalComputed = (n: number) => computed.decimals.some((c) => Math.abs(c - n) < 0.05);
  // Percentages: "78%".
  for (const m of body.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
    const n = Number(m[1]);
    if (!computed.percents.has(Math.round(n)) && !isDecimalComputed(n / 100)) unverified++;
  }
  // Decimals (a fractional part), excluding those already consumed as percents.
  const withoutPercents = body.replace(/\d+(?:\.\d+)?\s*%/g, " ");
  for (const m of withoutPercents.matchAll(/\b\d+\.\d+\b/g)) {
    const n = Number(m[0]);
    if (!isDecimalComputed(n)) unverified++;
  }
  return unverified;
}

const SYSTEM_PROMPT = `You are the WRITER for kazi-lab. You are a DOCUMENTARIAN, not an author. You turn one already-computed research thread into a clean, structured research write-up. You introduce NO new numbers, NO new findings, and NO new claims: your craft is structure and honest prose over material that already exists.

HARD RULES:
- Every substantive statement must trace to the assembled material: an audited-sound finding, a computed meta-analysis value, the stored interpretation, the stored spec, a Critic verdict, or the cross-domain link and its verdict. For each section, list the ids it rests on in provenance (use only ids from the CITEABLE IDS list).
- In the meta_analysis section, restate quantitative values ONLY from the computed tables provided; do not invent, round beyond the given precision, or compute anything new. Mark computed statements as computed and interpretive statements as interpretation, mirroring the source separation.
- Honesty is mandatory: if the interpretation verdict is "insufficient" or "mixed", say so plainly. If a scope library degraded to qualitative evidence (no metric layer), state it. The experiment is PROPOSED, not performed. Carry limitations, caveats, and human_decisions through; do not smooth them over.
- If conference themes are provided, you may steer FRAMING (venue-appropriate emphasis, what counts as the contribution) but never invent content to fit a venue.
- Write each section as clean prose (the meta_analysis section may use compact inline figures). Be specific and grounded, never generic filler.

Return ONLY valid JSON (no markdown, no commentary):
{
  "title": "a specific title for this thread",
  "conferences_considered": ["venue name", ...],
  "sections": {
    "abstract": { "heading": "Abstract", "body": "...", "provenance": ["<id>", ...] },
    "background": { "heading": "Background", "body": "...", "provenance": [...] },
    "claim_and_origin": { "heading": "Claim and origin", "body": "...", "provenance": [...] },
    "meta_analysis": { "heading": "Meta-analysis", "body": "...", "provenance": [...] },
    "proposed_experiment": { "heading": "Proposed experiment", "body": "...", "provenance": [...] },
    "limitations": { "heading": "Limitations", "body": "...", "provenance": [...] },
    "next_steps": { "heading": "Next steps", "body": "...", "provenance": [...] }
  }
}
Do not include a "results" section; it is generated separately. Use only ids from CITEABLE IDS in provenance.`;

// Document one research thread. Defaults to the latest completed Experimentalist
// run. Returns "nothing" (no run created) if there is nothing to document.
export async function runWriter(experimentalistRunId?: string): Promise<WriterResult> {
  const [expRun] = experimentalistRunId
    ? await db.select().from(experimentalistRuns).where(eq(experimentalistRuns.id, experimentalistRunId)).limit(1)
    : await db
        .select()
        .from(experimentalistRuns)
        .where(eq(experimentalistRuns.status, "completed"))
        .orderBy(desc(experimentalistRuns.completedAt))
        .limit(1);
  if (!expRun || expRun.status !== "completed") {
    return { status: "nothing", reason: "No completed Experimentalist run to document. Run the Experimentalist first." };
  }

  // --- ASSEMBLE THE THREAD (deterministic; no LLM) ----------------------
  const scopeIds = expRun.scopeLibraryIds;
  const libRows = await db.select({ id: libraries.id, name: libraries.name }).from(libraries).where(inArray(libraries.id, scopeIds.length ? scopeIds : ["00000000-0000-0000-0000-000000000000"]));
  const nameById = new Map(libRows.map((l) => [l.id, l.name]));

  const assemblies = new Map<string, LibraryAssembly>();
  for (const l of libRows) {
    const a = await assembleLibrary(l);
    if (a) assemblies.set(l.id, a);
  }

  // Meta-analysis rows grouped by key.
  const metaRows = await db.select().from(metaAnalyses).where(eq(metaAnalyses.runId, expRun.id));
  const keyMap = new Map<string, MetaKeyGroup>();
  for (const m of metaRows) {
    const k = `${m.keyDataset}|${m.keyMetric}|${m.keyTask}|${m.keyConditions}`;
    const entry = keyMap.get(k) ?? {
      id: "",
      dataset: m.keyDataset,
      metric: m.keyMetric,
      task: m.keyTask,
      conditions: m.keyConditions,
      nPapers: m.nPapers,
      nMethods: m.nMethods,
      kinds: {} as Record<string, unknown>,
    };
    entry.kinds[m.poolKind] = m.computed;
    if (m.poolKind === "best_median") entry.id = m.id;
    if (!entry.id) entry.id = m.id;
    keyMap.set(k, entry);
  }
  const metaKeys = [...keyMap.values()].sort((a, b) => (b.nPapers ?? 0) - (a.nPapers ?? 0));

  const qualRows = await db.select().from(qualitativeEvidence).where(eq(qualitativeEvidence.runId, expRun.id));
  const [spec] = await db.select().from(experimentSpecs).where(eq(experimentSpecs.runId, expRun.id));
  const interpretation = expRun.interpretation as
    | { verdict?: string; text?: string; caveats?: string[]; unknowns?: string[] }
    | null;

  // Upstream by input mode.
  const upstreamLines: string[] = [];
  const validRefs = new Set<string>();
  if (expRun.inputKind === "abstract") {
    const [ab] = await db
      .select({ id: criticAbstracts.id, title: criticAbstracts.title, abstractText: criticAbstracts.abstractText, claimToTest: criticAbstracts.claimToTest, direction: criticAbstracts.direction, groundedOn: criticAbstracts.groundedOn })
      .from(criticAbstracts)
      .where(eq(criticAbstracts.id, expRun.inputRef))
      .limit(1);
    if (ab) {
      validRefs.add(ab.id);
      upstreamLines.push(`ORIGIN: Critic direction-setting abstract ${ab.id}
  title: ${ab.title ?? "(none)"}
  claim_to_test: ${ab.claimToTest ?? "(none)"}
  direction: ${ab.direction ?? "(none)"}
  grounded on ${(ab.groundedOn ?? []).length} audited-sound item(s)`);
    }
  } else if (expRun.inputKind === "cross_domain_link") {
    const [link] = await db
      .select({ id: crossDomainLinks.id, summary: crossDomainLinks.summary, level: crossDomainLinks.level, libraryIds: crossDomainLinks.libraryIds })
      .from(crossDomainLinks)
      .where(eq(crossDomainLinks.id, expRun.inputRef))
      .limit(1);
    if (link) {
      validRefs.add(link.id);
      const ev = await db.select().from(crossDomainLinkEvidence).where(eq(crossDomainLinkEvidence.linkId, link.id));
      const [verdict] = await db
        .select({ id: linkVerdicts.id, verdict: linkVerdicts.verdict, rationale: linkVerdicts.rationale })
        .from(linkVerdicts)
        .innerJoin(crossDomainCriticRuns, eq(crossDomainCriticRuns.id, linkVerdicts.criticRunId))
        .where(and(eq(linkVerdicts.linkId, link.id), eq(crossDomainCriticRuns.status, "completed")))
        .orderBy(desc(crossDomainCriticRuns.completedAt))
        .limit(1);
      if (verdict) validRefs.add(verdict.id);
      upstreamLines.push(`ORIGIN: cross-domain ${link.level} link ${link.id}
  recurrence: ${link.summary}
  spans: ${link.libraryIds.map((id) => nameById.get(id) ?? id).join(" + ")}
  cross-domain Critic verdict: ${verdict ? `${verdict.verdict} (verdict ${verdict.id})` : "(not critiqued)"}${verdict?.rationale ? `\n  verdict rationale: ${verdict.rationale}` : ""}
  evidence: ${ev.map((e) => `[${nameById.get(e.libraryId) ?? e.libraryId}] ${e.evidenceKind}:${e.evidenceRef}`).join("; ")}`);
    }
  } else {
    upstreamLines.push("ORIGIN: derived from the library's audited synthesis (bare-library mode).");
  }

  // Citeable ids: findings + themes (via assemblies), meta keys, spec, qualitative, upstream.
  for (const a of assemblies.values()) {
    for (const id of a.findingIds) validRefs.add(id);
  }
  for (const k of metaKeys) validRefs.add(k.id);
  for (const q of qualRows) validRefs.add(q.id);
  if (spec) validRefs.add(spec.id);
  validRefs.add("interpretation");
  validRefs.add(expRun.id);

  // Conference context (framing only) for scope libraries.
  const confRows = await db
    .select({ name: libraryConferences.name, themes: libraryConferences.themes, scopeSummary: libraryConferences.scopeSummary })
    .from(libraryConferences)
    .where(and(inArray(libraryConferences.libraryId, scopeIds), eq(libraryConferences.synthStatus, "synthesized")));
  const conferenceNames = new Set(confRows.map((c) => c.name));

  // --- Build the LLM document -------------------------------------------
  const backgroundDoc = [...assemblies.values()]
    .map((a) => {
      const sound = a.findings.filter((f) => f.audit === "sound");
      return `LIBRARY ${a.name}
  themes: ${a.themes.map((t) => t.name).join(", ") || "(none)"}
  audited-sound findings:
${sound.length ? sound.map((f) => `    FINDING ${f.id} [${f.label ?? "?"}]: ${f.statement}`).join("\n") : "    (none audited sound)"}`;
    })
    .join("\n\n");

  const metaDoc = metaKeys.length
    ? metaKeys
        .map((k) => {
          const bm = k.kinds.best_median as { higherIsBetter?: boolean; methods?: { method: string; pooledValue: number; pooledFromSelf: boolean; conflict: boolean }[]; conflicts?: { method: string; values: number[] }[] } | undefined;
          const rk = k.kinds.rank as { ranks?: { method: string; meanRank: number; nPapers: number }[] } | undefined;
          const vc = k.kinds.vote_count as { winRates?: { method: string; winRate: number; wins: number; losses: number }[] } | undefined;
          const vw = k.kinds.variance_weighted_subset as { note?: string; weightedMean?: number } | undefined;
          const rankByM = new Map((rk?.ranks ?? []).map((r) => [r.method, r]));
          const winByM = new Map((vc?.winRates ?? []).map((w) => [w.method, w]));
          const methodLines = (bm?.methods ?? []).slice(0, 12).map((m) => {
            const r = rankByM.get(m.method);
            const w = winByM.get(m.method);
            return `      ${m.method}=${m.pooledValue}${m.pooledFromSelf ? "(self)" : ""}${m.conflict ? "[CONFLICT]" : ""} meanRank ${r ? r.meanRank.toFixed(2) : "-"}/${r?.nPapers ?? 0}p winRate ${w ? (w.winRate * 100).toFixed(0) + "%" : "-"}(${w?.wins ?? 0}-${w?.losses ?? 0})`;
          });
          return `META KEY ${k.id} [${k.dataset} | ${k.metric} | ${k.task} | ${k.conditions}] (${k.nPapers} papers, ${k.nMethods} methods, ${bm?.higherIsBetter ? "higher" : "lower"}-is-better) COMPUTED:
${methodLines.join("\n")}
      conflicts: ${(bm?.conflicts ?? []).map((c) => `${c.method}=${c.values.join(" vs ")}`).join("; ") || "none"}
      variance subset: ${vw ? `mean ${vw.weightedMean?.toFixed(3)} (${vw.note})` : "not eligible (<3 dispersion rows)"}`;
        })
        .join("\n\n")
    : "(no cross-paper poolable metric keys)";

  const qualDoc = qualRows.length
    ? [...new Set(qualRows.map((q) => q.libraryId))]
        .map((lid) => {
          const fs = qualRows.filter((q) => q.libraryId === lid);
          return `LIBRARY ${nameById.get(lid) ?? lid} (NO METRIC LAYER YET; qualitative evidence, no number can be pooled):\n${fs.map((f) => `    EVIDENCE ${f.id}: ${f.excerpt}`).join("\n")}`;
        })
        .join("\n\n")
    : "(all scope libraries have a metric layer)";

  const specDoc = spec
    ? `SPEC ${spec.id}
  title: ${spec.title}
  objective: ${spec.objective}
  design arms: ${JSON.stringify((spec.design as { arms?: string[] } | null)?.arms ?? [])}
  metrics: ${JSON.stringify(spec.metrics)}
  confirm: ${spec.confirmCriteria}
  refute: ${spec.refuteCriteria}
  environment: ${JSON.stringify(spec.environment)}
  verification harness: ${spec.verificationHarness}
  human decisions: ${JSON.stringify(spec.humanDecisions)}
  limitations: ${spec.limitations}`
    : "(no spec on this run)";

  const validityStatement =
    "VARIANCE-WEIGHTING VALIDITY: corpus dispersion coverage is ~1.3%; a variance-weighted random-effects meta-analysis is invalid and is not a headline result. Per-key variance-weighted means appear only where a slice has >=3 dispersion-bearing rows, labeled a subset.";

  const confDoc = confRows.length
    ? confRows.map((c) => `VENUE ${c.name}: themes [${(c.themes ?? []).join(", ")}]${c.scopeSummary ? `; scope: ${c.scopeSummary}` : ""}`).join("\n")
    : "(no conference context; write venue-neutral)";

  const citeList = [
    ...[...validRefs].filter((r) => r !== "interpretation" && r !== expRun.id).map((r) => `  ${r}`),
    "  interpretation (the stored Experimentalist interpretation)",
    `  ${expRun.id} (the Experimentalist run)`,
  ].join("\n");

  const userMessage = `CLAIM UNDER TEST: ${expRun.claim}
SCOPE: ${libRows.map((l) => l.name).join(", ")}
INPUT MODE: ${expRun.inputKind}
Experimentalist notes: ${expRun.notes ?? "(none)"}

${upstreamLines.join("\n\n")}

=== BACKGROUND (synthesis themes + audited-sound findings) ===
${backgroundDoc}

=== META-ANALYSIS (deterministic; restate numbers only from here) ===
${validityStatement}

${metaDoc}

=== QUALITATIVE EVIDENCE (metric-less libraries) ===
${qualDoc}

=== INTERPRETATION (the model reading of the computed tables) ===
verdict: ${interpretation?.verdict ?? "?"}
${interpretation?.text ?? "(none)"}
caveats: ${(interpretation?.caveats ?? []).join(" | ") || "(none)"}
unknowns: ${(interpretation?.unknowns ?? []).join(" | ") || "(none)"}

=== PROPOSED EXPERIMENT (spec; describe as PROPOSED, not performed) ===
${specDoc}

=== CONFERENCE CONTEXT (framing only) ===
${confDoc}

=== CITEABLE IDS (use only these in provenance) ===
${citeList}`;

  // Create the run row up front so a failure is visible.
  const [run] = await db
    .insert(writerRuns)
    .values({ experimentalistRunId: expRun.id, model: MODEL, status: "running" })
    .returning({ id: writerRuns.id });
  const writerRunId = run.id;

  try {
    const itemCount = metaKeys.length + [...assemblies.values()].reduce((n, a) => n + a.findings.length, 0);
    const maxTokens = Math.min(BASE_TOKENS + itemCount * PER_ITEM, MAX_OUTPUT_CAP);
    const client = new Anthropic();
    const resp = await client.messages
      .stream({ model: MODEL, max_tokens: maxTokens, system: SYSTEM_PROMPT, messages: [{ role: "user", content: userMessage }] })
      .finalMessage();
    const truncated = resp.stop_reason === "max_tokens";
    const block = resp.content.find((b) => b.type === "text");
    const raw = block && block.type === "text" ? block.text : "";
    let parsed: { title?: unknown; conferences_considered?: unknown; sections?: Record<string, { heading?: unknown; body?: unknown; provenance?: unknown }> };
    try {
      parsed = JSON.parse(extractJsonObject(raw));
    } catch (e) {
      if (truncated) throw new Error(`Writer output truncated (hit ${maxTokens} tokens); JSON incomplete, nothing written.`);
      throw new Error(`Failed to parse writer JSON: ${(e as Error).message}`);
    }

    const title = str(parsed.title) ?? `Research thread: ${expRun.claim.slice(0, 60)}`;
    const conferencesConsidered = strArray(parsed.conferences_considered).filter((c) => conferenceNames.has(c));

    // Assemble the fixed-order sections + validated provenance.
    const sections: Section[] = [];
    const provenance: Record<string, string[]> = {};
    let droppedRefs = 0;
    const kindOf: Record<SectionKey, string> = {
      abstract: "prose", background: "prose", claim_and_origin: "prose",
      meta_analysis: "computed", proposed_experiment: "proposed", results: "placeholder",
      limitations: "prose", next_steps: "prose",
    };
    for (const key of SECTION_KEYS) {
      if (key === "results") {
        sections.push({ key, heading: HEADINGS.results, body: RESULTS_PLACEHOLDER, kind: "placeholder" });
        provenance.results = spec ? [spec.id] : [];
        continue;
      }
      const modelSec = parsed.sections?.[key];
      const body = str(modelSec?.body) ?? "Nothing to report for this section in the current thread.";
      const refs = strArray(modelSec?.provenance);
      const validRefsForSection = refs.filter((r) => validRefs.has(r));
      droppedRefs += refs.length - validRefsForSection.length;
      sections.push({ key, heading: str(modelSec?.heading) ?? HEADINGS[key], body, kind: kindOf[key] });
      provenance[key] = validRefsForSection;
    }

    // Numeric membership validation on the meta_analysis section.
    const computed = collectComputedNumbers(metaKeys);
    const metaSection = sections.find((s) => s.key === "meta_analysis");
    const unverifiedNumbers = metaSection ? countUnverifiedNumbers(metaSection.body, computed) : 0;

    const noteParts: string[] = [];
    if (truncated) noteParts.push("Output truncated; sections may be incomplete.");
    if (droppedRefs) noteParts.push(`Dropped ${droppedRefs} provenance ref(s) that did not resolve.`);
    if (unverifiedNumbers) noteParts.push(`FLAG: ${unverifiedNumbers} number(s) in the meta-analysis section did not match a computed value; treat with suspicion.`);

    await db.transaction(async (tx) => {
      const [doc] = await tx
        .insert(researchDocuments)
        .values({ writerRunId, title, sections, provenance, conferencesConsidered })
        .returning({ id: researchDocuments.id });
      await tx
        .update(writerRuns)
        .set({ status: "completed", completedAt: new Date(), notes: noteParts.length ? noteParts.join(" ") : null })
        .where(eq(writerRuns.id, writerRunId));
      return doc;
    });

    const [doc] = await db.select({ id: researchDocuments.id }).from(researchDocuments).where(eq(researchDocuments.writerRunId, writerRunId)).limit(1);

    return {
      status: "completed",
      writerRunId,
      documentId: doc.id,
      title,
      sectionCount: sections.length,
      droppedRefs,
      unverifiedNumbers,
      conferencesConsidered,
      notes: noteParts.length ? noteParts.join(" ") : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(writerRuns).set({ status: "failed", completedAt: new Date(), error: message }).where(eq(writerRuns.id, writerRunId));
    throw error;
  }
}
