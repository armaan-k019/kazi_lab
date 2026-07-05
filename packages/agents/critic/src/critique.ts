import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  claims,
  claimRelations,
  contradictionVerdicts,
  criticAbstracts,
  criticRuns,
  db,
  findings,
  findingPapers,
  findingVerdicts,
  libraries,
  libraryConferences,
  MODELS,
  paperLibraries,
  papers,
  synthesisRuns,
} from "@kazi-lab/db";

// The Critic audits synthesis output, which is judgment-heavy adversarial
// reasoning, so it uses the shared judgment model (same model and call
// conventions as synthesis).
const MODEL = MODELS.judgment;

// Output budget scales with the number of audited items (contradictions +
// findings). Each verdict is small (a few fields plus a 1-2 sentence
// rationale), so a modest per-item increment over a base is plenty; the cap
// sits well under the Opus 4.8 output ceiling. The truncation guard is the backstop.
//   maxTokens = min(BASE + perItem * itemCount, CAP)
const BASE_TOKENS = 6_000;
const TOKENS_PER_ITEM = 700;
const MAX_OUTPUT_CAP = 32_000;
function critiqueMaxTokens(itemCount: number): number {
  return Math.min(BASE_TOKENS + itemCount * TOKENS_PER_ITEM, MAX_OUTPUT_CAP);
}

// The direction-setting abstract is a second, smaller Opus call after the
// audit. Keeping it separate keeps each JSON contract clean and each truncation
// guard reliable (bundling it would bloat the audit JSON).
const ABSTRACT_MAX_TOKENS = 2_500;

// BOUNDARY: the abstract stops at research direction, the claim to test, and a
// high-level conceptual approach. It must NOT specify executable experimental
// protocols, datasets, or methods-level procedures. The Experimentalist (the
// next agent, out of scope here) turns this direction into an executable design.
const ABSTRACT_SYSTEM_PROMPT = `You are the Critic writing a DIRECTION-SETTING ABSTRACT for a research library, to give later agents a grounded direction. You are given the library's hypothesis (if any), its research focus (if any), the target conference themes and scope (if any), and ONLY the findings and contradictions that survived your audit as SOUND.

Write a short abstract that sets a research direction. Rules:
- If a hypothesis is given, orient the direction around investigating or testing it. If none is given, propose the strongest real direction from the audited-sound findings (the most promising open question or gap).
- If conference themes/scope are given, steer the framing and what counts as a contribution toward those venues. If none, stay venue-neutral.
- Build ONLY on the sound findings and contradictions provided. Do NOT introduce claims they do not support. Record the ids you rely on in grounded_on.
- STOP at the research direction, the specific claim to test, and a high-level conceptual approach. Do NOT specify executable experimental protocols, datasets, hyperparameters, or step-by-step methods. A later Experimentalist agent will turn this into an executable design.

Return ONLY valid JSON (no markdown, no commentary) matching:
{ "title": "working title", "abstract_text": "1-2 paragraphs of direction-setting abstract", "claim_to_test": "the specific claim the proposed research would investigate", "direction": "the high-level conceptual approach", "grounded_on": ["id", ...], "conferences_considered": ["conference name", ...] }
Use only the finding and contradiction ids provided in grounded_on.`;

type RawAbstract = {
  title?: unknown;
  abstract_text?: unknown;
  claim_to_test?: unknown;
  direction?: unknown;
  grounded_on?: unknown;
  conferences_considered?: unknown;
};

const CONTRADICTION_VERDICTS = [
  "genuine",
  "definitional",
  "scope_dependent",
  "overstated",
] as const;
const LABEL_VERDICTS = ["justified", "inflated", "manufactured"] as const;
const GROUNDING_VERDICTS = ["grounded", "partially_grounded", "overreach"] as const;
const CONFIDENCES = ["low", "medium", "high"] as const;
const SEVERITIES = ["low", "medium", "high"] as const;

const SYSTEM_PROMPT = `You are the Critic for kazi-lab, an adversarial reviewer of one research library's SYNTHESIS OUTPUT. You are NOT reviewing the raw papers and you do NOT re-synthesize. You audit what the synthesis engine concluded: its "contradicts" relations between claims, and its findings (each with a strength label of consensus, contested, or single-source). You reason only over the claims and source passages you are given. Never invent claims, passages, papers, or ids.

CALIBRATION IS YOUR ENTIRE VALUE. Most contradictions and findings are probably SOUND. A Critic that flags everything is as useless as one that flags nothing. Confirm sound items as sound. Reserve an adverse verdict for a case where you can point to a concrete, passage-grounded reason. Every adverse verdict MUST cite the specific reason from the passages. If the provided evidence is insufficient to judge, say so with low confidence rather than inventing a critique.

For each CONTRADICTION (a "contradicts" relation between two claims), decide whether it is a real conflict or an artifact:
- "genuine": the two claims genuinely conflict on the same question under the same scope.
- "definitional": they use a key term differently; the conflict dissolves once terms are aligned.
- "scope_dependent": both hold in their own scope (different datasets, assumptions, regimes); not a true contradiction.
- "overstated": synthesis overread one or both claims; the conflict is weaker than labeled or absent.

For each FINDING, render TWO distinct verdicts:
1. label_verdict (is the strength label justified by the evidence?):
   - "justified": the consensus/contested/single-source label fits the evidence.
   - "inflated": labeled more strongly than the independent evidence supports (e.g. a "consensus" resting on few or non-independent sources; a "contested" manufactured from a single outlier).
   - "manufactured": the agreement or tension is largely a synthesis artifact, not present in the claims.
   Also judge INDEPENDENCE of the supporting claims (different papers/authors/methods, or correlated) and put it in independence_note.
2. grounding_verdict (does the finding statement actually follow from its supporting passages?):
   - "grounded": it follows from the supporting passages.
   - "partially_grounded": partly supported; some of the statement outruns the passages.
   - "overreach": the statement generalizes well beyond what the passages support.

SEVERITY: for any verdict that is NOT a clean pass (a contradiction not "genuine"; a finding that is "inflated"/"manufactured" or "partially_grounded"/"overreach"), assign severity "high" (if your verdict is right, it changes the synthesis's conclusions), "medium", or "low" (nitpick). For clean passes set severity to null.

Return ONLY valid JSON (no markdown, no commentary) matching this schema:

{
  "contradictions": [ { "claim_relation_id": "...", "verdict": "genuine|definitional|scope_dependent|overstated", "rationale": "1-2 sentences grounded in the passages", "confidence": "low|medium|high", "severity": "high|medium|low|null" } ],
  "findings": [ { "finding_id": "...", "label_verdict": "justified|inflated|manufactured", "grounding_verdict": "grounded|partially_grounded|overreach", "independence_note": "...", "rationale": "1-2 sentences grounded in the passages", "confidence": "low|medium|high", "severity": "high|medium|low|null" } ]
}

Use only the claim_relation_id and finding_id values provided. One entry per provided contradiction and per provided finding.`;

type RawVerdicts = {
  contradictions?: {
    claim_relation_id?: string;
    verdict?: string;
    rationale?: string;
    confidence?: string;
    severity?: string | null;
  }[];
  findings?: {
    finding_id?: string;
    label_verdict?: string;
    grounding_verdict?: string;
    independence_note?: string;
    rationale?: string;
    confidence?: string;
    severity?: string | null;
  }[];
};

export type CritiqueResult =
  | { status: "nothing"; reason: string }
  | {
      status: "completed";
      criticRunId: string;
      contradictionsAudited: number;
      findingsAudited: number;
      abstractGenerated: boolean;
    }
  | { status: "failed"; criticRunId: string; error: string };

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}
function oneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : null;
}

// Generate and store the direction-setting abstract. Grounds ONLY on the
// audited-sound items passed in; grounded_on ids are validated against them, so
// the abstract cannot rest on findings the audit flagged. Returns false (no
// insert) when there is nothing audited-sound to ground on. Throws on a model
// or parse failure so the caller can record a non-fatal note.
async function generateAbstract(args: {
  criticRunId: string;
  library: { name: string; hypothesis: string | null; researchFocus: string | null };
  conferences: { name: string; themes: string[] | null; scopeSummary: string | null }[];
  soundFindings: { id: string; statement: string }[];
  genuineContradictions: { id: string; fromText: string; toText: string }[];
}): Promise<boolean> {
  const allowed = new Set<string>([
    ...args.soundFindings.map((f) => f.id),
    ...args.genuineContradictions.map((c) => c.id),
  ]);
  if (allowed.size === 0) return false;

  const confDoc = args.conferences.length
    ? args.conferences
        .map(
          (c) =>
            `- ${c.name}: themes [${(c.themes ?? []).join(", ")}]` +
            (c.scopeSummary ? `; scope: ${c.scopeSummary}` : ""),
        )
        .join("\n")
    : "(none provided; write venue-neutral)";
  const findingDoc = args.soundFindings.length
    ? args.soundFindings.map((f) => `FINDING ${f.id}: ${f.statement}`).join("\n")
    : "(none)";
  const contraDoc = args.genuineContradictions.length
    ? args.genuineContradictions
        .map((c) => `CONTRADICTION ${c.id}: "${c.fromText}" vs "${c.toText}"`)
        .join("\n")
    : "(none)";

  const userMessage = `Library: ${args.library.name}
Hypothesis: ${args.library.hypothesis ?? "(none set; propose the strongest direction from the sound findings)"}
Research focus: ${args.library.researchFocus ?? "(none)"}

Target conferences:
${confDoc}

Audited-sound findings (build only on these):
${findingDoc}

Genuine contradictions (audited as real):
${contraDoc}`;

  const client = new Anthropic();
  const response = await client.messages
    .stream({
      model: MODEL,
      max_tokens: ABSTRACT_MAX_TOKENS,
      system: ABSTRACT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    })
    .finalMessage();
  const truncated = response.stop_reason === "max_tokens";
  const block = response.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text : "";
  let parsed: RawAbstract;
  try {
    parsed = JSON.parse(stripJsonFence(raw)) as RawAbstract;
  } catch (e) {
    throw new Error(
      truncated
        ? "Abstract output truncated; incomplete JSON."
        : `Failed to parse abstract JSON: ${(e as Error).message}`,
    );
  }
  const str = (v: unknown) =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  // id-validation guard: grounded_on must reference audited-sound ids only.
  const groundedOn = Array.isArray(parsed.grounded_on)
    ? parsed.grounded_on.filter((x): x is string => typeof x === "string" && allowed.has(x))
    : [];
  const conferencesConsidered = Array.isArray(parsed.conferences_considered)
    ? parsed.conferences_considered.filter((x): x is string => typeof x === "string")
    : [];

  await db.insert(criticAbstracts).values({
    criticRunId: args.criticRunId,
    title: str(parsed.title),
    abstractText: str(parsed.abstract_text),
    claimToTest: str(parsed.claim_to_test),
    direction: str(parsed.direction),
    groundedOn,
    conferencesConsidered,
  });
  return true;
}

// Audit the latest completed synthesis run for a library. Returns "nothing"
// (without creating a run) if there is no synthesis to critique.
export async function runCritique(libraryId: string): Promise<CritiqueResult> {
  const [library] = await db
    .select({
      id: libraries.id,
      name: libraries.name,
      hypothesis: libraries.hypothesis,
      researchFocus: libraries.researchFocus,
    })
    .from(libraries)
    .where(eq(libraries.id, libraryId))
    .limit(1);
  if (!library) throw new Error(`Library not found: ${libraryId}`);

  const [synth] = await db
    .select({ id: synthesisRuns.id })
    .from(synthesisRuns)
    .where(
      and(
        eq(synthesisRuns.libraryId, libraryId),
        eq(synthesisRuns.status, "completed"),
      ),
    )
    .orderBy(desc(synthesisRuns.completedAt))
    .limit(1);
  if (!synth) {
    return {
      status: "nothing",
      reason: "No completed synthesis to critique. Synthesize this library first.",
    };
  }

  // Library papers (id -> title) and their claims (id -> text, passage), so we
  // can resolve relations and finding supports to grounded passages.
  const libPapers = await db
    .select({ id: papers.id, title: papers.title })
    .from(papers)
    .innerJoin(paperLibraries, eq(paperLibraries.paperId, papers.id))
    .where(eq(paperLibraries.libraryId, libraryId));
  const titleByPaper = new Map(libPapers.map((p) => [p.id, p.title]));
  const paperIds = libPapers.map((p) => p.id);
  const claimRows = paperIds.length
    ? await db
        .select({
          id: claims.id,
          paperId: claims.paperId,
          text: claims.text,
          sourcePassage: claims.sourcePassage,
        })
        .from(claims)
        .where(inArray(claims.paperId, paperIds))
    : [];
  const claimById = new Map(claimRows.map((c) => [c.id, c]));

  // Contradictions = "contradicts" relations in this synthesis run.
  const contradictionRels = await db
    .select({
      id: claimRelations.id,
      fromClaimId: claimRelations.fromClaimId,
      toClaimId: claimRelations.toClaimId,
      rationale: claimRelations.rationale,
    })
    .from(claimRelations)
    .where(
      and(
        eq(claimRelations.synthesisRunId, synth.id),
        eq(claimRelations.relationType, "contradicts"),
      ),
    );
  const validContradictionIds = new Set(contradictionRels.map((r) => r.id));

  // Findings in this run + their supporting (paper, claim) pairs.
  const findingRows = await db
    .select({
      id: findings.id,
      statement: findings.statement,
      detail: findings.detail,
      consensus: findings.consensus,
    })
    .from(findings)
    .where(eq(findings.synthesisRunId, synth.id));
  const validFindingIds = new Set(findingRows.map((f) => f.id));
  const findingIds = findingRows.map((f) => f.id);
  const supportRows = findingIds.length
    ? await db
        .select({
          findingId: findingPapers.findingId,
          paperId: findingPapers.paperId,
          supportingClaimId: findingPapers.supportingClaimId,
        })
        .from(findingPapers)
        .where(inArray(findingPapers.findingId, findingIds))
    : [];
  const supportsByFinding = new Map<string, typeof supportRows>();
  for (const s of supportRows) {
    const arr = supportsByFinding.get(s.findingId) ?? [];
    arr.push(s);
    supportsByFinding.set(s.findingId, arr);
  }

  if (contradictionRels.length === 0 && findingRows.length === 0) {
    return {
      status: "nothing",
      reason: "The latest synthesis has no findings or contradictions to audit.",
    };
  }

  // Build the audit document.
  const claimLine = (cid: string) => {
    const c = claimById.get(cid);
    if (!c) return `  (claim ${cid} not found)`;
    const title = titleByPaper.get(c.paperId) ?? "unknown paper";
    return (
      `  paper "${title}": "${c.text}"` +
      (c.sourcePassage ? `\n    source: ${c.sourcePassage}` : "\n    source: (none)")
    );
  };

  const contradictionDoc = contradictionRels
    .map((r) =>
      [
        `CONTRADICTION ${r.id}`,
        `Synthesis rationale: ${r.rationale ?? "(none)"}`,
        `Claim A:`,
        claimLine(r.fromClaimId),
        `Claim B:`,
        claimLine(r.toClaimId),
      ].join("\n"),
    )
    .join("\n\n");

  const findingDoc = findingRows
    .map((f) => {
      const supports = supportsByFinding.get(f.id) ?? [];
      const supportLines = supports.map((s) => {
        const title = titleByPaper.get(s.paperId) ?? "unknown paper";
        const claim = s.supportingClaimId
          ? claimById.get(s.supportingClaimId)
          : null;
        return claim
          ? `  paper "${title}": "${claim.text}"` +
              (claim.sourcePassage ? `\n    source: ${claim.sourcePassage}` : "")
          : `  paper "${title}" (no specific claim cited)`;
      });
      return [
        `FINDING ${f.id}`,
        `Statement: ${f.statement}`,
        `Synthesis strength label: ${f.consensus ?? "(none)"}`,
        f.detail ? `Detail: ${f.detail}` : "",
        `Supporting claims:`,
        supportLines.length ? supportLines.join("\n") : "  (no supports recorded)",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const userMessage = `Library: ${library.name}
Contradictions to audit: ${contradictionRels.length}
Findings to audit: ${findingRows.length}

=== CONTRADICTIONS ===
${contradictionDoc || "(none)"}

=== FINDINGS ===
${findingDoc || "(none)"}`;

  // Create the run row up front (mirrors synthesis) so failures are visible.
  const [run] = await db
    .insert(criticRuns)
    .values({
      libraryId,
      synthesisRunId: synth.id,
      model: MODEL,
      status: "running",
    })
    .returning({ id: criticRuns.id });
  const criticRunId = run.id;

  try {
    const itemCount = contradictionRels.length + findingRows.length;
    const maxTokens = critiqueMaxTokens(itemCount);
    const client = new Anthropic();
    // Stream and take the final message (at these max_tokens the SDK rejects a
    // non-streaming request); finalMessage() returns the same Message shape.
    const response = await client.messages
      .stream({
        model: MODEL,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      })
      .finalMessage();

    const truncated = response.stop_reason === "max_tokens";
    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";

    let parsed: RawVerdicts;
    try {
      parsed = JSON.parse(stripJsonFence(raw)) as RawVerdicts;
    } catch (parseErr) {
      // Truncation guard: if the output hit the ceiling and the JSON is
      // therefore incomplete, fail cleanly with a clear note (outer catch
      // marks the run failed) rather than writing partial garbage.
      if (truncated) {
        throw new Error(
          `Critic output truncated at ${itemCount} items (hit the ${maxTokens}-token ceiling); the JSON is incomplete, so no verdicts were written.`,
        );
      }
      throw new Error(
        `Failed to parse critic JSON: ${(parseErr as Error).message}\n\nRaw:\n${raw.slice(0, 3000)}`,
      );
    }

    const noteParts: string[] = [];
    let droppedContra = 0;
    let droppedFinding = 0;

    const contraValues = (parsed.contradictions ?? [])
      .map((c) => {
        const id = c.claim_relation_id ?? "";
        const verdict = oneOf(c.verdict, CONTRADICTION_VERDICTS);
        // id-validation guard: drop hallucinated or out-of-run ids.
        if (!validContradictionIds.has(id) || !verdict) {
          droppedContra++;
          return null;
        }
        const severity =
          verdict === "genuine" ? null : (oneOf(c.severity, SEVERITIES) ?? "medium");
        return {
          criticRunId,
          claimRelationId: id,
          verdict,
          rationale: c.rationale ?? null,
          confidence: oneOf(c.confidence, CONFIDENCES),
          severity,
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    const findingValues = (parsed.findings ?? [])
      .map((f) => {
        const id = f.finding_id ?? "";
        const labelVerdict = oneOf(f.label_verdict, LABEL_VERDICTS);
        const groundingVerdict = oneOf(f.grounding_verdict, GROUNDING_VERDICTS);
        if (!validFindingIds.has(id) || !labelVerdict || !groundingVerdict) {
          droppedFinding++;
          return null;
        }
        const clean = labelVerdict === "justified" && groundingVerdict === "grounded";
        const severity = clean ? null : (oneOf(f.severity, SEVERITIES) ?? "medium");
        return {
          criticRunId,
          findingId: id,
          labelVerdict,
          groundingVerdict,
          independenceNote: f.independence_note ?? null,
          rationale: f.rationale ?? null,
          confidence: oneOf(f.confidence, CONFIDENCES),
          severity,
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    if (truncated) noteParts.push("Output truncated; verdicts may be incomplete.");
    if (droppedContra)
      noteParts.push(`Dropped ${droppedContra} contradiction verdict(s) with invalid ids.`);
    if (droppedFinding)
      noteParts.push(`Dropped ${droppedFinding} finding verdict(s) with invalid ids.`);

    await db.transaction(async (tx) => {
      if (contraValues.length)
        await tx.insert(contradictionVerdicts).values(contraValues);
      if (findingValues.length)
        await tx.insert(findingVerdicts).values(findingValues);
      await tx
        .update(criticRuns)
        .set({
          status: "completed",
          completedAt: new Date(),
          notes: noteParts.length ? noteParts.join(" ") : null,
        })
        .where(eq(criticRuns.id, criticRunId));
    });

    // Direction-setting abstract (non-fatal, mirrors synthesis narration): the
    // audit is already stored, so an abstract failure only records a note.
    let abstractGenerated = false;
    try {
      const soundFindings = findingValues
        .filter((v) => v.labelVerdict === "justified" && v.groundingVerdict === "grounded")
        .map((v) => ({
          id: v.findingId,
          statement: findingRows.find((f) => f.id === v.findingId)?.statement ?? "",
        }));
      const genuineContradictions = contraValues
        .filter((v) => v.verdict === "genuine")
        .map((v) => {
          const rel = contradictionRels.find((r) => r.id === v.claimRelationId);
          return {
            id: v.claimRelationId,
            fromText: rel ? (claimById.get(rel.fromClaimId)?.text ?? "") : "",
            toText: rel ? (claimById.get(rel.toClaimId)?.text ?? "") : "",
          };
        });
      const confRows = await db
        .select({
          name: libraryConferences.name,
          themes: libraryConferences.themes,
          scopeSummary: libraryConferences.scopeSummary,
        })
        .from(libraryConferences)
        .where(
          and(
            eq(libraryConferences.libraryId, libraryId),
            eq(libraryConferences.synthStatus, "synthesized"),
          ),
        );
      abstractGenerated = await generateAbstract({
        criticRunId,
        library: {
          name: library.name,
          hypothesis: library.hypothesis,
          researchFocus: library.researchFocus,
        },
        conferences: confRows,
        soundFindings,
        genuineContradictions,
      });
      if (!abstractGenerated) {
        const merged = [...noteParts, "No audited-sound findings to ground an abstract."];
        await db
          .update(criticRuns)
          .set({ notes: merged.join(" ") })
          .where(eq(criticRuns.id, criticRunId));
      }
    } catch (absErr) {
      const msg = absErr instanceof Error ? absErr.message : String(absErr);
      console.error("Abstract step failed (audit still stored):", msg);
      const merged = [...noteParts, `Abstract could not be generated: ${msg.slice(0, 160)}`];
      await db
        .update(criticRuns)
        .set({ notes: merged.join(" ") })
        .where(eq(criticRuns.id, criticRunId));
    }

    return {
      status: "completed",
      criticRunId,
      contradictionsAudited: contraValues.length,
      findingsAudited: findingValues.length,
      abstractGenerated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(criticRuns)
      .set({ status: "failed", completedAt: new Date(), error: message })
      .where(eq(criticRuns.id, criticRunId));
    throw error;
  }
}
