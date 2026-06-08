import Anthropic from "@anthropic-ai/sdk";
import { eq, inArray } from "drizzle-orm";
import {
  claims,
  claimRelations,
  db,
  extractions,
  findings,
  findingPapers,
  libraries,
  openQuestions,
  paperLibraries,
  paperNarrations,
  papers,
  paperThemes,
  synthesisRuns,
  themes,
} from "@kazi-lab/db";

// Synthesis is the judgment-heavy task, so it uses Opus (per-paper extraction
// uses Sonnet). claude-opus-4-6 is a current, valid Opus model.
const MODEL = "claude-opus-4-6";
const MAX_TOKENS = 16000;

// Narration is descriptive writing grounded in the already-computed relations,
// not the hard cross-paper judgment Opus already did, so Sonnet is enough and
// cheaper.
const NARRATION_MODEL = "claude-sonnet-4-6";
const NARRATION_MAX_TOKENS = 4000;

const NARRATION_PROMPT = `You are writing short positioning notes for papers in a research library. For each paper, write 2-4 sentences describing its place in THIS library's web of relationships: what it builds on or extends, what it is supported by or contradicts or is contradicted by, and its distinct contribution relative to the OTHER papers in this library. Ground every statement in the provided relations and corpus. Do not restate the paper's abstract in isolation; position it relative to its neighbors. Be specific and concise. If a paper has few or no relations, say briefly that it stands relatively independent in this library and note its core contribution. Return ONLY JSON: { "narrations": [ { "paper_id": "...", "narration": "..." } ] }, one entry per paper id provided. Never invent relations not present in the data.`;

type RelEntry = {
  fromPaperId: string;
  toPaperId: string;
  relationType: string;
  rationale: string | null;
};

// One Sonnet call producing a positioning paragraph per paper, grounded in the
// finalized relations. Returns [] on any failure (caller treats it as
// supplementary and never fails the run over it).
async function generateNarrations(
  libraryName: string,
  papersInfo: {
    id: string;
    title: string;
    problem: string | null;
    method: string | null;
  }[],
  relations: RelEntry[],
  validPaperIds: Set<string>,
): Promise<{ paperId: string; narration: string }[]> {
  const titleOf = new Map(papersInfo.map((p) => [p.id, p.title]));
  const doc = papersInfo
    .map((p) => {
      const rels = relations
        .filter((r) => r.fromPaperId === p.id || r.toPaperId === p.id)
        .map((r) => {
          const outgoing = r.fromPaperId === p.id;
          const other = titleOf.get(outgoing ? r.toPaperId : r.fromPaperId);
          const dir = outgoing
            ? `this paper ${r.relationType} "${other}"`
            : `"${other}" ${r.relationType} this paper`;
          return `  - ${dir}${r.rationale ? ` — ${r.rationale}` : ""}`;
        });
      return [
        `PAPER ${p.id}`,
        `Title: ${p.title}`,
        p.problem ? `Problem: ${p.problem}` : "",
        p.method ? `Method: ${p.method}` : "",
        "Relations:",
        rels.length ? rels.join("\n") : "  - no cross-paper relations in this library",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const client = new Anthropic();
  const response = await client.messages.create({
    model: NARRATION_MODEL,
    max_tokens: NARRATION_MAX_TOKENS,
    system: NARRATION_PROMPT,
    messages: [
      { role: "user", content: `Library: ${libraryName}\n\n${doc}` },
    ],
  });
  const block = response.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text : "";
  const fenced = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const parsed = JSON.parse(fenced ? fenced[1].trim() : raw.trim()) as {
    narrations?: { paper_id?: string; narration?: string }[];
  };
  return (parsed.narrations ?? [])
    .filter(
      (n): n is { paper_id: string; narration: string } =>
        typeof n?.paper_id === "string" &&
        typeof n?.narration === "string" &&
        n.narration.trim().length > 0 &&
        validPaperIds.has(n.paper_id),
    )
    .map((n) => ({ paperId: n.paper_id, narration: n.narration.trim() }));
}

export type SynthesisCounts = {
  runId: string;
  themeCount: number;
  findingCount: number;
  relationCount: number;
  openQuestionCount: number;
};

const SYSTEM_PROMPT = `You are the synthesis engine for kazi-lab, a research lab that studies how ideas connect across papers. You are given the full corpus of one research library: a set of papers, each with extracted fields (problem, method, results, limitations) and a set of atomic claims (each with an id, the claim text, a source passage, and the paper's confidence language).

Your job is to find the real structure in this corpus. Be rigorous and specific. Do not state generic connections. A connection is only worth reporting if it is substantive and a knowledgeable reader would find it genuinely informative. When in doubt, report fewer, higher-quality connections rather than many shallow ones.

Produce the following:

1. THEMES: the recurring topics this library clusters around. For each theme: a short name, a 1-2 sentence description, and the list of paper ids that belong to it. A paper can be in multiple themes. Aim for the natural number of themes, not a fixed count. Do not force papers into themes they do not genuinely belong to.

2. FINDINGS: synthesized insights that emerge from reading across the corpus. A finding is NOT a single paper's claim restated; it is an insight that the corpus collectively supports or reveals. For each finding: a statement, a short detail, the supporting paper ids, and where possible the specific supporting claim id from each paper. Also assign a consensus value: "consensus" if multiple papers independently support it, "contested" if papers disagree about it, "single-source" if only one paper supports it but it is notable.

3. CLAIM RELATIONS: specific directed relationships between claims FROM DIFFERENT PAPERS. Use the claim ids provided. Types:
   - "supports": claim A reinforces or provides evidence for claim B
   - "contradicts": claim A conflicts with claim B
   - "extends": claim A builds on or generalizes claim B
   For each: from_claim_id, to_claim_id, relation_type, and a one-sentence rationale. Only relate claims from DIFFERENT papers. Only report relations that are real and substantive. Contradictions are especially valuable, find genuine ones, but do not manufacture them.

4. OPEN QUESTIONS: questions this corpus raises but does not answer. These are gaps: things the papers point toward, assume, or leave unresolved. For each: the question, a rationale for why the corpus raises but does not answer it, and the related paper ids. These should be genuinely useful to a researcher deciding what to work on next. This is one of the most valuable outputs, take it seriously.

Return ONLY valid JSON (no markdown, no commentary) matching this schema:

{
  "themes": [ { "name": "...", "description": "...", "paper_ids": ["..."] } ],
  "findings": [ { "statement": "...", "detail": "...", "consensus": "consensus|contested|single-source", "supports": [ { "paper_id": "...", "claim_id": "... or null" } ] } ],
  "relations": [ { "from_claim_id": "...", "to_claim_id": "...", "relation_type": "supports|contradicts|extends", "rationale": "..." } ],
  "open_questions": [ { "question": "...", "rationale": "...", "related_paper_ids": ["..."] } ]
}

Ground every id in the corpus you were given. Never invent ids. If you cannot find a precise claim id for a finding's support, use null for claim_id but still give the paper_id.`;

type RawSynthesis = {
  themes?: { name: string; description?: string; paper_ids?: string[] }[];
  findings?: {
    statement: string;
    detail?: string;
    consensus?: string;
    supports?: { paper_id: string; claim_id?: string | null }[];
  }[];
  relations?: {
    from_claim_id: string;
    to_claim_id: string;
    relation_type: string;
    rationale?: string;
  }[];
  open_questions?: {
    question: string;
    rationale?: string;
    related_paper_ids?: string[];
  }[];
};

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

// Step 1: validate the library has >=2 papers and create the run row. Returns
// the runId immediately so an API route can respond before the heavy work.
export async function createSynthesisRun(libraryId: string): Promise<string> {
  const [library] = await db
    .select({ id: libraries.id, name: libraries.name })
    .from(libraries)
    .where(eq(libraries.id, libraryId))
    .limit(1);
  if (!library) throw new Error(`Library not found: ${libraryId}`);

  const paperRows = await db
    .select({ id: papers.id })
    .from(papers)
    .innerJoin(paperLibraries, eq(paperLibraries.paperId, papers.id))
    .where(eq(paperLibraries.libraryId, libraryId));

  if (paperRows.length < 2) {
    throw new Error("Synthesis needs at least 2 papers.");
  }

  const [run] = await db
    .insert(synthesisRuns)
    .values({
      libraryId,
      status: "running",
      model: MODEL,
      paperCount: paperRows.length,
    })
    .returning({ id: synthesisRuns.id });
  return run.id;
}

// Step 2: the heavy work. Reads the libraryId from the run row, gathers the
// corpus, calls Opus, writes results in a transaction, and marks the run
// completed or failed. On error it marks the run failed and rethrows.
export async function runSynthesis(runId: string): Promise<SynthesisCounts> {
  const [run] = await db
    .select({ id: synthesisRuns.id, libraryId: synthesisRuns.libraryId })
    .from(synthesisRuns)
    .where(eq(synthesisRuns.id, runId))
    .limit(1);
  if (!run) throw new Error(`Synthesis run not found: ${runId}`);
  if (!run.libraryId) throw new Error(`Run ${runId} has no library.`);
  const libraryId = run.libraryId;

  try {
    const [library] = await db
      .select({ id: libraries.id, name: libraries.name })
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .limit(1);
    if (!library) throw new Error(`Library not found: ${libraryId}`);

    const libPapers = await db
      .select({ id: papers.id, title: papers.title, authors: papers.authors })
      .from(papers)
      .innerJoin(paperLibraries, eq(paperLibraries.paperId, papers.id))
      .where(eq(paperLibraries.libraryId, libraryId));

    const paperIds = libPapers.map((p) => p.id);
    const validPaperIds = new Set(paperIds);

    const exts = await db
      .select({
        paperId: extractions.paperId,
        problem: extractions.problem,
        method: extractions.method,
        results: extractions.results,
        limitations: extractions.limitations,
        keyTerms: extractions.keyTerms,
      })
      .from(extractions)
      .where(inArray(extractions.paperId, paperIds));
    const extByPaper = new Map(exts.map((e) => [e.paperId, e]));

    const allClaims = await db
      .select({
        id: claims.id,
        paperId: claims.paperId,
        text: claims.text,
        sourcePassage: claims.sourcePassage,
        confidence: claims.confidence,
      })
      .from(claims)
      .where(inArray(claims.paperId, paperIds));
    const validClaimIds = new Set(allClaims.map((c) => c.id));
    const claimPaper = new Map(allClaims.map((c) => [c.id, c.paperId]));
    const claimsByPaper = new Map<string, typeof allClaims>();
    for (const c of allClaims) {
      const arr = claimsByPaper.get(c.paperId) ?? [];
      arr.push(c);
      claimsByPaper.set(c.paperId, arr);
    }

    const corpus = libPapers
      .map((p) => {
        const e = extByPaper.get(p.id);
        const cs = claimsByPaper.get(p.id) ?? [];
        const lines = [
          `PAPER ${p.id}`,
          `Title: ${p.title}`,
          `Authors: ${p.authors.join(", ")}`,
          e?.problem ? `Problem: ${e.problem}` : "",
          e?.method ? `Method: ${e.method}` : "",
          e?.results ? `Results: ${e.results}` : "",
          e?.limitations ? `Limitations: ${e.limitations}` : "",
          e?.keyTerms?.length ? `Key terms: ${e.keyTerms.join(", ")}` : "",
          "Claims:",
          ...cs.map(
            (c) =>
              `  CLAIM ${c.id} [confidence: ${c.confidence ?? "n/a"}]: ${c.text}` +
              (c.sourcePassage ? `\n    source: ${c.sourcePassage}` : ""),
          ),
        ];
        return lines.filter(Boolean).join("\n");
      })
      .join("\n\n");

    const userMessage = `Library: ${library.name}\nPapers: ${libPapers.length}\n\n${corpus}`;

    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";

    let parsed: RawSynthesis;
    try {
      parsed = JSON.parse(stripJsonFence(raw)) as RawSynthesis;
    } catch (parseErr) {
      throw new Error(
        `Failed to parse synthesis JSON: ${(parseErr as Error).message}\n\nRaw response:\n${raw.slice(0, 4000)}`,
      );
    }

    let relationCount = 0;
    let skippedRelations = 0;
    // Captured during the tx so the narration step can reuse the finalized,
    // validated relations without re-deriving them.
    const validRelations: RelEntry[] = [];
    const counts = await db.transaction(async (tx) => {
      const themeRows = parsed.themes ?? [];
      for (const t of themeRows) {
        if (!t?.name) continue;
        const [insertedTheme] = await tx
          .insert(themes)
          .values({
            synthesisRunId: runId,
            name: t.name,
            description: t.description ?? null,
          })
          .returning({ id: themes.id });
        const links = (t.paper_ids ?? [])
          .filter((pid) => validPaperIds.has(pid))
          .map((pid) => ({ paperId: pid, themeId: insertedTheme.id }));
        if (links.length) {
          await tx.insert(paperThemes).values(links).onConflictDoNothing();
        }
      }

      const findingRows = parsed.findings ?? [];
      for (const f of findingRows) {
        if (!f?.statement) continue;
        const [insertedFinding] = await tx
          .insert(findings)
          .values({
            synthesisRunId: runId,
            statement: f.statement,
            detail: f.detail ?? null,
            consensus: f.consensus ?? null,
          })
          .returning({ id: findings.id });
        const supports = (f.supports ?? []).filter((s) =>
          validPaperIds.has(s.paper_id),
        );
        const seen = new Set<string>();
        for (const s of supports) {
          if (seen.has(s.paper_id)) continue;
          seen.add(s.paper_id);
          const claimId =
            s.claim_id && validClaimIds.has(s.claim_id) ? s.claim_id : null;
          await tx
            .insert(findingPapers)
            .values({
              findingId: insertedFinding.id,
              paperId: s.paper_id,
              supportingClaimId: claimId,
            })
            .onConflictDoNothing();
        }
      }

      const relationRows = parsed.relations ?? [];
      for (const r of relationRows) {
        const from = r?.from_claim_id;
        const to = r?.to_claim_id;
        if (
          !from ||
          !to ||
          from === to ||
          !validClaimIds.has(from) ||
          !validClaimIds.has(to) ||
          claimPaper.get(from) === claimPaper.get(to)
        ) {
          skippedRelations++;
          continue;
        }
        await tx.insert(claimRelations).values({
          synthesisRunId: runId,
          fromClaimId: from,
          toClaimId: to,
          relationType: r.relation_type,
          rationale: r.rationale ?? null,
        });
        validRelations.push({
          fromPaperId: claimPaper.get(from)!,
          toPaperId: claimPaper.get(to)!,
          relationType: r.relation_type,
          rationale: r.rationale ?? null,
        });
        relationCount++;
      }

      const oqRows = parsed.open_questions ?? [];
      for (const q of oqRows) {
        if (!q?.question) continue;
        await tx.insert(openQuestions).values({
          synthesisRunId: runId,
          libraryId,
          question: q.question,
          rationale: q.rationale ?? null,
          relatedPaperIds: (q.related_paper_ids ?? []).filter((pid) =>
            validPaperIds.has(pid),
          ),
        });
      }

      return {
        themeCount: themeRows.filter((t) => t?.name).length,
        findingCount: findingRows.filter((f) => f?.statement).length,
        openQuestionCount: oqRows.filter((q) => q?.question).length,
      };
    });

    await db
      .update(synthesisRuns)
      .set({
        status: "completed",
        completedAt: new Date(),
        notes: skippedRelations
          ? `Skipped ${skippedRelations} relation(s) with invalid/same-paper claim ids.`
          : null,
      })
      .where(eq(synthesisRuns.id, runId));

    // Narration is supplementary: generate and store per-paper positioning
    // paragraphs, but never fail the (already completed) run if it errors.
    try {
      const narrations = await generateNarrations(
        library.name,
        libPapers.map((p) => ({
          id: p.id,
          title: p.title,
          problem: extByPaper.get(p.id)?.problem ?? null,
          method: extByPaper.get(p.id)?.method ?? null,
        })),
        validRelations,
        validPaperIds,
      );
      if (narrations.length) {
        await db.insert(paperNarrations).values(
          narrations.map((n) => ({
            synthesisRunId: runId,
            paperId: n.paperId,
            narration: n.narration,
          })),
        );
      }
      console.log(`Wrote ${narrations.length} paper narrations.`);
    } catch (narrErr) {
      const msg = narrErr instanceof Error ? narrErr.message : String(narrErr);
      console.error("Narration step failed (run still completed):", msg);
      await db
        .update(synthesisRuns)
        .set({
          notes: `${skippedRelations ? `Skipped ${skippedRelations} relation(s). ` : ""}Narration failed: ${msg.slice(0, 200)}`,
        })
        .where(eq(synthesisRuns.id, runId));
    }

    return { runId, relationCount, ...counts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(synthesisRuns)
      .set({ status: "failed", completedAt: new Date(), error: message })
      .where(eq(synthesisRuns.id, runId));
    throw error;
  }
}

// CLI / single-call entry: create the run then do the work, awaited.
export async function synthesizeLibrary(
  libraryId: string,
): Promise<SynthesisCounts> {
  const runId = await createSynthesisRun(libraryId);
  return runSynthesis(runId);
}
