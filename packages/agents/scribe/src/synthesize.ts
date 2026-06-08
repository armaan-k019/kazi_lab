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
  papers,
  paperThemes,
  synthesisRuns,
  themes,
} from "@kazi-lab/db";

// Synthesis is the judgment-heavy task, so it uses Opus (per-paper extraction
// uses Sonnet). claude-opus-4-6 is a current, valid Opus model.
const MODEL = "claude-opus-4-6";
const MAX_TOKENS = 16000;

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

export async function synthesizeLibrary(
  libraryId: string,
): Promise<SynthesisCounts> {
  // --- Gather the library's corpus ---------------------------------------
  const [library] = await db
    .select({ id: libraries.id, name: libraries.name })
    .from(libraries)
    .where(eq(libraries.id, libraryId))
    .limit(1);
  if (!library) throw new Error(`Library not found: ${libraryId}`);

  const libPapers = await db
    .select({
      id: papers.id,
      title: papers.title,
      authors: papers.authors,
    })
    .from(papers)
    .innerJoin(paperLibraries, eq(paperLibraries.paperId, papers.id))
    .where(eq(paperLibraries.libraryId, libraryId));

  const paperIds = libPapers.map((p) => p.id);
  const validPaperIds = new Set(paperIds);

  const exts = paperIds.length
    ? await db
        .select({
          paperId: extractions.paperId,
          problem: extractions.problem,
          method: extractions.method,
          results: extractions.results,
          limitations: extractions.limitations,
          keyTerms: extractions.keyTerms,
        })
        .from(extractions)
        .where(inArray(extractions.paperId, paperIds))
    : [];
  const extByPaper = new Map(exts.map((e) => [e.paperId, e]));

  const allClaims = paperIds.length
    ? await db
        .select({
          id: claims.id,
          paperId: claims.paperId,
          text: claims.text,
          sourcePassage: claims.sourcePassage,
          confidence: claims.confidence,
        })
        .from(claims)
        .where(inArray(claims.paperId, paperIds))
    : [];
  const validClaimIds = new Set(allClaims.map((c) => c.id));
  const claimPaper = new Map(allClaims.map((c) => [c.id, c.paperId]));
  const claimsByPaper = new Map<string, typeof allClaims>();
  for (const c of allClaims) {
    const arr = claimsByPaper.get(c.paperId) ?? [];
    arr.push(c);
    claimsByPaper.set(c.paperId, arr);
  }

  // --- Create the run row -------------------------------------------------
  const [run] = await db
    .insert(synthesisRuns)
    .values({
      libraryId,
      status: "running",
      model: MODEL,
      paperCount: libPapers.length,
    })
    .returning({ id: synthesisRuns.id });
  const runId = run.id;

  const empty: SynthesisCounts = {
    runId,
    themeCount: 0,
    findingCount: 0,
    relationCount: 0,
    openQuestionCount: 0,
  };

  // Synthesis needs at least 2 papers to find connections.
  if (libPapers.length < 2) {
    await db
      .update(synthesisRuns)
      .set({
        status: "failed",
        completedAt: new Date(),
        error: "Need at least 2 papers to synthesize.",
        notes: `Library "${library.name}" has ${libPapers.length} paper(s).`,
      })
      .where(eq(synthesisRuns.id, runId));
    return empty;
  }

  try {
    // --- Build the corpus document ---------------------------------------
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

    // --- Call Opus -------------------------------------------------------
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

    // --- Write results in a transaction ----------------------------------
    let relationCount = 0;
    let skippedRelations = 0;
    const counts = await db.transaction(async (tx) => {
      // Themes + paper_themes
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

      // Findings + finding_papers
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
        // Dedupe by paper (finding_papers PK is finding_id + paper_id).
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

      // Claim relations: only when both ids exist, are different, and come
      // from different papers.
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
        relationCount++;
      }

      // Open questions
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
