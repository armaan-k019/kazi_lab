import Anthropic from "@anthropic-ai/sdk";
import { desc, eq, inArray } from "drizzle-orm";
import {
  assembleLibrary,
  extractJsonObject,
  resolveEvidenceRef,
  runCrossDomainCritique,
  type LibraryAssembly,
} from "@kazi-lab/lab";
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

export type ProposeResult =
  | { status: "nothing"; reason: string }
  | {
      status: "completed";
      webRunId: string;
      crossDomainRunId: string | null;
      proposed: number;
      droppedNoGrounding: number;
      critique: { confirmed: number; promoted: number; demoted: number; rejected: number } | null;
      note: string | null;
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

// Turn the research web's top ABC candidates into conservative, structure-mapped
// crossover proposals and hand them to the EXISTING cross-domain pipeline as
// candidates (source = web_discovery), so the existing Critic can audit them.
export async function proposeCrossovers(
  webRunId?: string,
  opts: { autoAudit?: boolean } = {},
): Promise<ProposeResult> {
  const autoAudit = opts.autoAudit ?? true;

  const [run] = webRunId
    ? await db.select({ id: webBuildRuns.id, status: webBuildRuns.status }).from(webBuildRuns).where(eq(webBuildRuns.id, webRunId)).limit(1)
    : await db.select({ id: webBuildRuns.id, status: webBuildRuns.status }).from(webBuildRuns).where(eq(webBuildRuns.status, "completed")).orderBy(desc(webBuildRuns.completedAt)).limit(1);
  if (!run || run.status !== "completed") {
    return { status: "nothing", reason: "No completed web build to propose from. Build the web first." };
  }

  const abcOnly = (await db.select().from(webBridges).where(eq(webBridges.runId, run.id)))
    .filter((b) => b.kind === "abc")
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
  const candidates = abcOnly.map((b) => b.payload as AbcPayload);
  if (candidates.length === 0) {
    return { status: "nothing", reason: "This web build produced no ABC candidates to propose from." };
  }

  // Build library assemblies for non-general libraries with a completed synthesis
  // (the only libraries whose claims can be grounded through resolveEvidenceRef).
  const libRows = await db.select({ id: libraries.id, name: libraries.name }).from(libraries);
  const assemblies = new Map<string, LibraryAssembly>();
  for (const l of libRows) {
    if (isAllPapersLibrary(l.name)) continue;
    const a = await assembleLibrary(l);
    if (a) assemblies.set(l.id, a);
  }

  // Candidate evidence papers -> their claims + library memberships (with assembly).
  const candidatePaperIds = new Set<string>();
  for (const c of candidates) {
    for (const pth of c.path_evidence ?? []) {
      for (const p of pth.a_leg_papers) candidatePaperIds.add(p.id);
      for (const p of pth.c_leg_papers) candidatePaperIds.add(p.id);
    }
  }
  const paperIdList = [...candidatePaperIds];
  const claimsByPaper = new Map<string, { id: string; text: string }[]>();
  if (paperIdList.length) {
    const claimRows = await db.select({ id: claimsTable.id, paperId: claimsTable.paperId, text: claimsTable.text }).from(claimsTable).where(inArray(claimsTable.paperId, paperIdList));
    for (const c of claimRows) {
      const arr = claimsByPaper.get(c.paperId) ?? [];
      arr.push({ id: c.id, text: c.text });
      claimsByPaper.set(c.paperId, arr);
    }
  }
  const libsByPaper = new Map<string, string[]>();
  if (paperIdList.length) {
    const plRows = await db.select({ paperId: paperLibraries.paperId, libraryId: paperLibraries.libraryId }).from(paperLibraries).where(inArray(paperLibraries.paperId, paperIdList));
    for (const r of plRows) {
      const arr = libsByPaper.get(r.paperId) ?? [];
      arr.push(r.libraryId);
      libsByPaper.set(r.paperId, arr);
    }
  }

  // Ground one paper: find a (libraryId, claim) whose claim resolves through the
  // existing resolveEvidenceRef against that library's assembly. Returns null if
  // the paper belongs to no synthesized library (honest drop).
  const groundPaper = (paperId: string): { libraryId: string; claimId: string; excerpt: string } | null => {
    for (const libId of libsByPaper.get(paperId) ?? []) {
      const assembly = assemblies.get(libId);
      if (!assembly) continue;
      for (const claim of claimsByPaper.get(paperId) ?? []) {
        const { valid } = resolveEvidenceRef(assembly, "claim", claim.id);
        if (valid) return { libraryId: libId, claimId: claim.id, excerpt: claim.text.slice(0, 200) };
      }
    }
    return null;
  };

  // Present the candidates to the proposer.
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
      if (truncated) throw new Error(`Proposer output truncated (hit ${MAX_TOKENS} tokens); nothing written.`);
      throw new Error(`Failed to parse proposer JSON: ${(e as Error).message}`);
    }
  } catch (error) {
    throw error;
  }

  // Build grounded links (deterministic). Each proposal must cite papers from its
  // candidate's evidence and resolve to >=2 valid claim evidence rows, else drop.
  type LinkInsert = {
    level: string;
    summary: string;
    rationale: string;
    libraryIds: string[];
    evidence: { libraryId: string; evidenceKind: string; evidenceRef: string; excerpt: string }[];
  };
  const links: LinkInsert[] = [];
  let droppedNoGrounding = 0;
  for (const p of proposalsRaw) {
    const idx = typeof p.candidate_index === "number" ? p.candidate_index : -1;
    const cand = candidates[idx];
    const mapping = str(p.mapping);
    const claimToTest = str(p.claim_to_test);
    if (!cand || !mapping || !claimToTest) {
      droppedNoGrounding++;
      continue;
    }
    // Only accept cited papers that appear in this candidate's evidence.
    const evidencePaperIds = new Set<string>();
    for (const pth of cand.path_evidence ?? []) {
      for (const x of pth.a_leg_papers) evidencePaperIds.add(x.id);
      for (const x of pth.c_leg_papers) evidencePaperIds.add(x.id);
    }
    const cited = [...strArray(p.a_papers), ...strArray(p.c_papers)].filter((id) => evidencePaperIds.has(id));
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
      continue;
    }
    // level: "method" where the mapping is a shared method node, else "concept".
    const level = cand.a_node.startsWith("method:") || cand.c_node.startsWith("method:") ? "method" : "concept";
    const libraryIds = [...new Set(evidence.map((e) => e.libraryId))];
    links.push({ level, summary: mapping, rationale: `${str(p.why_structural) ?? ""} Claim to test: ${claimToTest}`.trim(), libraryIds, evidence });
  }

  if (links.length === 0) {
    return { status: "completed", webRunId: run.id, crossDomainRunId: null, proposed: 0, droppedNoGrounding, critique: null, note: "No proposals met the grounding bar. That is an acceptable outcome for conservative discovery." };
  }

  // HANDOFF: one cross_domain_run whose links are web_discovery candidates,
  // audited by the EXISTING cross-domain Critic. is_candidate + source enforced.
  const scope = [...new Set(links.flatMap((l) => l.libraryIds))];
  const [cdRun] = await db.insert(crossDomainRuns).values({ scope, model: MODEL, status: "completed", completedAt: new Date(), notes: `web discovery run ${run.id}` }).returning({ id: crossDomainRuns.id });
  await db.transaction(async (tx) => {
    for (const l of links) {
      const [inserted] = await tx
        .insert(crossDomainLinks)
        .values({
          crossDomainRunId: cdRun.id,
          level: l.level,
          summary: l.summary,
          libraryIds: l.libraryIds,
          confidence: "low",
          // Server-side enforcement: web discovery NEVER asserts.
          isCandidate: true,
          source: "web_discovery",
          rationale: l.rationale,
        })
        .returning({ id: crossDomainLinks.id });
      await tx.insert(crossDomainLinkEvidence).values(l.evidence.map((e) => ({ linkId: inserted.id, libraryId: e.libraryId, evidenceKind: e.evidenceKind, evidenceRef: e.evidenceRef, excerpt: e.excerpt })));
    }
  });

  // Optionally audit the run with the EXISTING Critic so proposals arrive graded.
  let critique: { confirmed: number; promoted: number; demoted: number; rejected: number } | null = null;
  let note: string | null = null;
  if (autoAudit) {
    try {
      const result = await runCrossDomainCritique(cdRun.id);
      if (result.status === "completed") critique = result.verdicts;
      else note = `Auto-audit did not complete: ${result.status}.`;
    } catch (e) {
      note = `Auto-audit failed (proposals still persisted): ${(e as Error).message.slice(0, 120)}`;
    }
  }

  return { status: "completed", webRunId: run.id, crossDomainRunId: cdRun.id, proposed: links.length, droppedNoGrounding, critique, note };
}
