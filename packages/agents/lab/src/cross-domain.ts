import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  claims,
  crossDomainLinkEvidence,
  crossDomainLinks,
  crossDomainRuns,
  criticRuns,
  db,
  findings,
  findingVerdicts,
  isAllPapersLibrary,
  libraries,
  MODELS,
  openQuestions,
  paperLibraries,
  paperMetrics,
  papers,
  synthesisRuns,
  themes,
} from "@kazi-lab/db";
import { extractJsonObject } from "./json";

// Cross-domain synthesis is hard judgment across multiple domains (is this the
// SAME thing or just the same word?), so it uses the shared judgment model, the
// same model and call conventions as Scribe synthesis and the Critic.
const MODEL = MODELS.judgment;

// Output budget scales with the number of items the model reasons over (findings
// + methods across all libraries). Each link is a few fields plus a handful of
// evidence rows, so a modest per-item increment over a base is plenty; the cap
// sits well under the Opus 4.8 output ceiling. The truncation guard is the backstop.
const BASE_TOKENS = 8_000;
const TOKENS_PER_ITEM = 60;
const MAX_OUTPUT_CAP = 24_000;
function crossDomainMaxTokens(itemCount: number): number {
  return Math.min(BASE_TOKENS + itemCount * TOKENS_PER_ITEM, MAX_OUTPUT_CAP);
}

// Per-library assembly caps so the document stays bounded.
const MAX_FINDINGS = 50;
const MAX_METHODS = 60;
const MAX_QUESTIONS = 20;

export const LEVELS = ["method", "claim", "concept"] as const;
export const KINDS = ["method", "finding", "claim"] as const;
export const CONFIDENCES = ["low", "medium", "high"] as const;

const SYSTEM_PROMPT = `You are the lab-level CROSS-DOMAIN SYNTHESIZER for kazi-lab, a research lab holding several independent projects (libraries). Each library has already been synthesized (themes, findings with strength labels, open questions) and most have been audited by a Critic. You read ACROSS libraries and surface what GENUINELY RECURS across domains, grounded in concrete evidence. You do NOT re-synthesize a single library and you do NOT pressure-test your own output (a separate cross-domain Critic does that next).

GROUNDING IS THE ENTIRE POINT. Surface recurrence at three levels:
- "method": the SAME algorithm/technique/structural approach appears in two or more libraries (e.g. a clustering method, diffusion, a graph construction). Cite the specific method name in EACH library.
- "claim": the SAME KIND of audited finding recurs across libraries. Cite the specific finding (by its id) in EACH library. PREFER findings the Critic audited as sound; a recurrence built on a finding the Critic flagged as inflated/overreach is itself suspect.
- "concept": an emergent conceptual rhyme (e.g. "structure treated as queryable data recurs"). A concept link is NEVER asserted on its own. It must POINT TO the underlying method/claim recurrences via its evidence, and you must set is_candidate true. A concept rhyme with no concrete underlying evidence is NOT to be emitted.

HARD RULES:
- Every link cites the specific libraries it spans (>=2) and concrete evidence in EACH (>=1 evidence item per library). NO link without provenance.
- evidence.ref must be REAL: for kind "method" it is a method name that actually appears in that library (in its method inventory or named in its findings text); for kind "finding" it is one of the finding ids given for that library; for kind "claim" it is a claim id given for that library. Never invent an id or a method that is not present.
- PREFER FALSE-NEGATIVE over FALSE-POSITIVE. If you are unsure whether two things across domains are genuinely the same versus superficially similar (same word, different meaning), set is_candidate true and confidence low. Do NOT assert a weak rhyme as real. Surfacing a vocabulary coincidence as established is the failure mode to avoid.
- The lab thesis (spatial structure / clustering / coordinates as queryable data recurring across domains) is a HYPOTHESIS to TEST against the evidence, NOT a lens to force matches through. Do not bend findings to fit it. If cross-domain recurrence is thin or mostly superficial, SAY SO in honest_read and emit few or only candidate links. Thin and honest beats inflated.
- A method/claim link you are confident is genuinely the same may have is_candidate false. Anything concept-level, or anything uncertain, is is_candidate true.

Return ONLY valid JSON (no markdown, no commentary) matching:
{
  "links": [
    {
      "level": "method|claim|concept",
      "summary": "the recurrence stated plainly in one sentence",
      "libraries": ["<library name>", "<library name>"],
      "confidence": "low|medium|high",
      "is_candidate": true,
      "rationale": "why this is (or is not yet) a genuine cross-domain recurrence",
      "evidence": [
        { "library": "<library name>", "kind": "method|finding|claim", "ref": "<method name or finding/claim id>", "excerpt": "the concrete thing and where it appears" }
      ]
    }
  ],
  "honest_read": "your candid assessment: is cross-domain recurrence here real and grounded, or thin/superficial? Name the strongest grounded links and the ones that are only vocabulary coincidences."
}
Use only the library names, finding ids, and method names provided. Emit one evidence item per library per link at minimum.`;

type RawEvidence = {
  library?: unknown;
  kind?: unknown;
  ref?: unknown;
  excerpt?: unknown;
};
type RawLink = {
  level?: unknown;
  summary?: unknown;
  libraries?: unknown;
  confidence?: unknown;
  is_candidate?: unknown;
  rationale?: unknown;
  evidence?: unknown;
};
type RawOutput = { links?: RawLink[]; honest_read?: unknown };

// Audit status of a finding for claim-level grounding.
export type AuditStatus = "sound" | "flagged" | "unaudited";

export type LibraryAssembly = {
  id: string;
  name: string;
  synthesisRunId: string;
  hasCritic: boolean;
  themes: { name: string; description: string | null }[];
  findings: {
    id: string;
    statement: string;
    label: string | null;
    audit: AuditStatus;
  }[];
  openQuestions: string[];
  methods: string[]; // structured method inventory (from paper_metrics)
  findingIds: Set<string>;
  findingAudit: Map<string, AuditStatus>;
  claimIds: Set<string>;
  corpus: string; // lowercased text blob for method-name validation
};

export type CrossDomainResult =
  | { status: "insufficient"; reason: string; eligible: string[]; skipped: { name: string; reason: string }[] }
  | {
      status: "completed";
      runId: string;
      scope: string[];
      skipped: { name: string; reason: string }[];
      counts: {
        method: { grounded: number; candidate: number };
        claim: { grounded: number; candidate: number };
        concept: { grounded: number; candidate: number };
      };
      droppedLinks: number;
      droppedEvidence: number;
      honestRead: string | null;
    }
  | { status: "failed"; runId: string; error: string };

export function oneOf<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : null;
}
export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
export function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// The single evidence-resolution check, shared by cross-domain synthesis and the
// cross-domain Critic's discovery pass so both ground links against the real
// assembled data identically. A ref is valid only if it resolves to a real
// thing in the named library: a method named in the inventory or grounded
// corpus, a real finding id, or a real claim id. For findings it also returns
// the Critic audit status so callers can downgrade links resting on flagged or
// unaudited findings.
export function resolveEvidenceRef(
  a: LibraryAssembly,
  kind: (typeof KINDS)[number],
  ref: string,
): { valid: boolean; audit: AuditStatus | null } {
  if (kind === "method") {
    const n = normalize(ref);
    return { valid: n.length >= 3 && a.corpus.includes(n), audit: null };
  }
  if (kind === "finding") {
    const valid = a.findingIds.has(ref);
    return { valid, audit: valid ? (a.findingAudit.get(ref) ?? "unaudited") : null };
  }
  return { valid: a.claimIds.has(ref), audit: null };
}

// Assemble the cross-domain inputs for one eligible library: its latest
// synthesis (themes, findings, open questions), the Critic verdicts on those
// findings (to prefer audited-sound), and its method inventory + a validation
// corpus. Returns null if the library has no completed synthesis (caller skips).
export async function assembleLibrary(lib: {
  id: string;
  name: string;
}): Promise<LibraryAssembly | null> {
  const [synth] = await db
    .select({ id: synthesisRuns.id })
    .from(synthesisRuns)
    .where(and(eq(synthesisRuns.libraryId, lib.id), eq(synthesisRuns.status, "completed")))
    .orderBy(desc(synthesisRuns.completedAt))
    .limit(1);
  if (!synth) return null;

  const themeRows = await db
    .select({ name: themes.name, description: themes.description })
    .from(themes)
    .where(eq(themes.synthesisRunId, synth.id));

  const findingRows = await db
    .select({ id: findings.id, statement: findings.statement, consensus: findings.consensus })
    .from(findings)
    .where(eq(findings.synthesisRunId, synth.id));

  // Critic verdicts: latest completed critic run that audited THIS synthesis run.
  const [critic] = await db
    .select({ id: criticRuns.id })
    .from(criticRuns)
    .where(
      and(
        eq(criticRuns.libraryId, lib.id),
        eq(criticRuns.synthesisRunId, synth.id),
        eq(criticRuns.status, "completed"),
      ),
    )
    .orderBy(desc(criticRuns.completedAt))
    .limit(1);
  const findingAudit = new Map<string, AuditStatus>();
  if (critic) {
    const verdicts = await db
      .select({
        findingId: findingVerdicts.findingId,
        labelVerdict: findingVerdicts.labelVerdict,
        groundingVerdict: findingVerdicts.groundingVerdict,
      })
      .from(findingVerdicts)
      .where(eq(findingVerdicts.criticRunId, critic.id));
    for (const v of verdicts) {
      const sound = v.labelVerdict === "justified" && v.groundingVerdict === "grounded";
      findingAudit.set(v.findingId, sound ? "sound" : "flagged");
    }
  }

  const qRows = await db
    .select({ question: openQuestions.question })
    .from(openQuestions)
    .where(eq(openQuestions.synthesisRunId, synth.id));

  // Library papers, claims (for claim-id validation + the validation corpus).
  const libPapers = await db
    .select({ id: papers.id })
    .from(papers)
    .innerJoin(paperLibraries, eq(paperLibraries.paperId, papers.id))
    .where(eq(paperLibraries.libraryId, lib.id));
  const paperIds = libPapers.map((p) => p.id);
  const claimRows = paperIds.length
    ? await db
        .select({ id: claims.id, text: claims.text })
        .from(claims)
        .where(inArray(claims.paperId, paperIds))
    : [];

  // Structured method inventory from paper_metrics (most frequent first).
  const methodRows = paperIds.length
    ? await db
        .select({ methodName: paperMetrics.methodName })
        .from(paperMetrics)
        .where(inArray(paperMetrics.paperId, paperIds))
    : [];
  const methodFreq = new Map<string, number>();
  for (const m of methodRows) {
    const name = str(m.methodName);
    if (!name) continue;
    methodFreq.set(name, (methodFreq.get(name) ?? 0) + 1);
  }
  const methods = [...methodFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_METHODS)
    .map(([name]) => name);

  // Validation corpus for method-name evidence: lowercased blob of every
  // grounded text in this library (themes, findings, claims, methods, questions).
  // A method evidence_ref must actually appear here.
  const corpus = normalize(
    [
      ...themeRows.map((t) => `${t.name} ${t.description ?? ""}`),
      ...findingRows.map((f) => f.statement),
      ...claimRows.map((c) => c.text),
      ...methods,
      ...qRows.map((q) => q.question),
    ].join(" \n "),
  );

  const findingList = findingRows.slice(0, MAX_FINDINGS).map((f) => ({
    id: f.id,
    statement: f.statement,
    label: f.consensus,
    audit: findingAudit.get(f.id) ?? ("unaudited" as AuditStatus),
  }));

  return {
    id: lib.id,
    name: lib.name,
    synthesisRunId: synth.id,
    hasCritic: !!critic,
    themes: themeRows,
    findings: findingList,
    openQuestions: qRows.map((q) => q.question).slice(0, MAX_QUESTIONS),
    methods,
    findingIds: new Set(findingRows.map((f) => f.id)),
    findingAudit,
    claimIds: new Set(claimRows.map((c) => c.id)),
    corpus,
  };
}

export function libraryDoc(a: LibraryAssembly): string {
  const themeLine = a.themes.length
    ? a.themes.map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ""}`).join("\n")
    : "(none)";
  const findingLine = a.findings.length
    ? a.findings
        .map(
          (f) =>
            `FINDING ${f.id} [audit: ${f.audit}] (label: ${f.label ?? "none"}): ${f.statement}`,
        )
        .join("\n")
    : "(none)";
  const methodLine = a.methods.length
    ? a.methods.join(", ")
    : "(no structured method inventory; cite methods named in the findings text above)";
  const qLine = a.openQuestions.length
    ? a.openQuestions.map((q) => `- ${q}`).join("\n")
    : "(none)";
  return `=== LIBRARY: ${a.name} ===
Critic audit available: ${a.hasCritic ? "yes (prefer audit=sound findings)" : "no (findings are unaudited; any claim-level link resting on them is lower-confidence)"}

Themes:
${themeLine}

Findings:
${findingLine}

Method inventory (structured): ${methodLine}

Open questions:
${qLine}`;
}

// Run lab-level cross-domain synthesis over a set of libraries. Defaults to all
// non-general libraries that have a completed synthesis. Requires >=2 eligible
// libraries (else returns "insufficient" WITHOUT creating a run). A run is an
// immutable snapshot; prior runs are never mutated.
export async function runCrossDomainSynthesis(
  libraryIds?: string[],
): Promise<CrossDomainResult> {
  const allLibs = await db
    .select({ id: libraries.id, name: libraries.name })
    .from(libraries);

  // Candidate set: requested ids (if given) intersected with all libraries,
  // else all libraries. General is always excluded.
  const requested = libraryIds && libraryIds.length ? new Set(libraryIds) : null;
  const candidates = allLibs.filter(
    (l) => !isAllPapersLibrary(l.name) && (!requested || requested.has(l.id)),
  );

  const skipped: { name: string; reason: string }[] = [];
  const assemblies: LibraryAssembly[] = [];
  for (const lib of candidates) {
    const a = await assembleLibrary(lib);
    if (!a) {
      skipped.push({ name: lib.name, reason: "no completed synthesis; synthesize it first" });
      continue;
    }
    assemblies.push(a);
  }
  // Note any general library that was present (excluded by design).
  for (const l of allLibs) {
    if (isAllPapersLibrary(l.name)) {
      skipped.push({ name: l.name, reason: "general all-papers view, excluded from cross-domain analysis" });
    }
  }

  if (assemblies.length < 2) {
    return {
      status: "insufficient",
      reason:
        "Cross-domain synthesis needs at least two synthesized projects. Add and synthesize more libraries.",
      eligible: assemblies.map((a) => a.name),
      skipped,
    };
  }

  const byName = new Map(assemblies.map((a) => [a.name, a]));
  const itemCount = assemblies.reduce((n, a) => n + a.findings.length + a.methods.length, 0);
  const userMessage = `Libraries in scope: ${assemblies.map((a) => a.name).join(", ")}

${assemblies.map(libraryDoc).join("\n\n")}`;

  // Create the run row up front (mirrors Scribe/Critic) so a failure is visible.
  const [run] = await db
    .insert(crossDomainRuns)
    .values({
      scope: assemblies.map((a) => a.id),
      model: MODEL,
      status: "running",
    })
    .returning({ id: crossDomainRuns.id });
  const runId = run.id;

  try {
    const maxTokens = crossDomainMaxTokens(itemCount);
    const client = new Anthropic();
    const response = await client.messages
      .stream({
        model: MODEL,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      })
      .finalMessage();

    const truncated = response.stop_reason === "max_tokens";
    const block = response.content.find((b) => b.type === "text");
    const raw = block && block.type === "text" ? block.text : "";

    let parsed: RawOutput;
    try {
      parsed = JSON.parse(extractJsonObject(raw)) as RawOutput;
    } catch (parseErr) {
      if (truncated) {
        throw new Error(
          `Cross-domain output truncated at ${itemCount} items (hit the ${maxTokens}-token ceiling); the JSON is incomplete, so nothing was written.`,
        );
      }
      throw new Error(
        `Failed to parse cross-domain JSON: ${(parseErr as Error).message}\n\nRaw:\n${raw.slice(0, 2000)}`,
      );
    }

    let droppedLinks = 0;
    let droppedEvidence = 0;

    type LinkInsert = {
      level: (typeof LEVELS)[number];
      summary: string;
      libraryIds: string[];
      confidence: (typeof CONFIDENCES)[number] | null;
      isCandidate: boolean;
      rationale: string | null;
      evidence: {
        libraryId: string;
        evidenceKind: (typeof KINDS)[number];
        evidenceRef: string;
        excerpt: string | null;
      }[];
    };

    const prepared: LinkInsert[] = [];
    for (const link of parsed.links ?? []) {
      const level = oneOf(link.level, LEVELS);
      const summary = str(link.summary);
      if (!level || !summary) {
        droppedLinks++;
        continue;
      }

      // Validate each evidence row against the real assembled data.
      const evidence: LinkInsert["evidence"] = [];
      let restsOnFlagged = false;
      let restsOnUnaudited = false;
      for (const ev of Array.isArray(link.evidence) ? (link.evidence as RawEvidence[]) : []) {
        const libName = str(ev.library);
        const kind = oneOf(ev.kind, KINDS);
        const ref = str(ev.ref);
        const a = libName ? byName.get(libName) : undefined;
        if (!a || !kind || !ref) {
          droppedEvidence++;
          continue;
        }
        // id/name validation guard: the ref must resolve to a real thing.
        // Shared with the Critic's discovery pass (resolveEvidenceRef).
        const { valid, audit } = resolveEvidenceRef(a, kind, ref);
        if (audit === "flagged") restsOnFlagged = true;
        if (audit === "unaudited") restsOnUnaudited = true;
        if (!valid) {
          droppedEvidence++;
          continue;
        }
        evidence.push({
          libraryId: a.id,
          evidenceKind: kind,
          evidenceRef: ref,
          excerpt: str(ev.excerpt),
        });
      }

      // A link must span >=2 distinct libraries with VALID evidence (>=1 each).
      const coveredLibs = [...new Set(evidence.map((e) => e.libraryId))];
      if (coveredLibs.length < 2) {
        droppedLinks++;
        continue;
      }

      let confidence = oneOf(link.confidence, CONFIDENCES);
      // Grounding discipline enforced in code, not just asked of the model:
      // concept links and low-confidence links are always candidates; a
      // claim-level link resting on a Critic-flagged finding is downgraded.
      let isCandidate =
        link.is_candidate === true || level === "concept" || confidence === "low";
      if (level === "claim" && restsOnFlagged) {
        confidence = "low";
        isCandidate = true;
      } else if (level === "claim" && restsOnUnaudited && confidence === "high") {
        // Un-audited findings cannot support a high-confidence assertion.
        confidence = "medium";
      }

      prepared.push({
        level,
        summary,
        libraryIds: coveredLibs,
        confidence,
        isCandidate,
        rationale: str(link.rationale),
        evidence,
      });
    }

    const honestRead = str(parsed.honest_read);
    const noteParts: string[] = [];
    if (honestRead) noteParts.push(honestRead);
    if (skipped.length)
      noteParts.push(`Skipped: ${skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}.`);
    if (truncated) noteParts.push("Output truncated; links may be incomplete.");
    if (droppedLinks) noteParts.push(`Dropped ${droppedLinks} link(s) with insufficient grounding.`);
    if (droppedEvidence) noteParts.push(`Dropped ${droppedEvidence} evidence row(s) that did not resolve.`);

    // Write links + evidence + run completion atomically.
    await db.transaction(async (tx) => {
      for (const p of prepared) {
        const [inserted] = await tx
          .insert(crossDomainLinks)
          .values({
            crossDomainRunId: runId,
            level: p.level,
            summary: p.summary,
            libraryIds: p.libraryIds,
            confidence: p.confidence,
            isCandidate: p.isCandidate,
            rationale: p.rationale,
          })
          .returning({ id: crossDomainLinks.id });
        if (p.evidence.length) {
          await tx.insert(crossDomainLinkEvidence).values(
            p.evidence.map((e) => ({
              linkId: inserted.id,
              libraryId: e.libraryId,
              evidenceKind: e.evidenceKind,
              evidenceRef: e.evidenceRef,
              excerpt: e.excerpt,
            })),
          );
        }
      }
      await tx
        .update(crossDomainRuns)
        .set({
          status: "completed",
          completedAt: new Date(),
          notes: noteParts.length ? noteParts.join(" ") : null,
        })
        .where(eq(crossDomainRuns.id, runId));
    });

    const counts = {
      method: { grounded: 0, candidate: 0 },
      claim: { grounded: 0, candidate: 0 },
      concept: { grounded: 0, candidate: 0 },
    };
    for (const p of prepared) {
      if (p.isCandidate) counts[p.level].candidate++;
      else counts[p.level].grounded++;
    }

    return {
      status: "completed",
      runId,
      scope: assemblies.map((a) => a.name),
      skipped,
      counts,
      droppedLinks,
      droppedEvidence,
      honestRead,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(crossDomainRuns)
      .set({ status: "failed", completedAt: new Date(), error: message })
      .where(eq(crossDomainRuns.id, runId));
    throw error;
  }
}
