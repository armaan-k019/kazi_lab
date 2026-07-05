import Anthropic from "@anthropic-ai/sdk";
import { desc, eq, inArray } from "drizzle-orm";
import {
  crossDomainCriticRuns,
  crossDomainLinkEvidence,
  crossDomainLinks,
  crossDomainRuns,
  db,
  libraries,
  linkVerdicts,
  MODELS,
} from "@kazi-lab/db";
import { extractJsonObject } from "./json";
import {
  assembleLibrary,
  CONFIDENCES,
  KINDS,
  LEVELS,
  libraryDoc,
  oneOf,
  resolveEvidenceRef,
  str,
  type LibraryAssembly,
} from "./cross-domain";

// Both passes are hard adversarial judgment across domains, so they use the
// shared judgment model, same conventions as synthesis and the per-library Critic.
const MODEL = MODELS.judgment;

// Validation output scales with the number of links audited (one verdict +
// rationale each). Discovery scales with the per-library material scanned.
const VALIDATION_BASE_TOKENS = 6_000;
const VALIDATION_TOKENS_PER_LINK = 900;
const DISCOVERY_BASE_TOKENS = 6_000;
const DISCOVERY_TOKENS_PER_ITEM = 60;
const MAX_OUTPUT_CAP = 24_000; // backstop, well under the Opus 4.8 ceiling

const VERDICTS = ["confirmed", "promoted", "demoted", "rejected"] as const;

// PASS A: skeptical. Attack every link; a recurrence survives only if the same
// mechanism does the same work in each domain.
const VALIDATION_SYSTEM_PROMPT = `You are the CROSS-DOMAIN CRITIC for kazi-lab, running the VALIDATION pass. You are a skeptic. Your job is to ATTACK each proposed cross-domain link and decide whether it is a genuine, load-bearing recurrence or a superficial one. The lab must not fool itself into believing two domains rhyme when they only share a word.

For a recurrence to be GENUINE, the SAME mechanism (the same algorithm/method, or the same specific claim) must do the SAME work in each library. Reject as superficial when:
- it is a vocabulary coincidence (the same word means mechanically different things in each domain),
- it is a near-universal ML truism that is true almost everywhere and so says nothing specific about these domains (e.g. "pretraining helps", "more data helps", "deep models beat shallow ones", "scaling improves results"),
- the shared thing is real in one library but only loosely analogized in the other.

Each link arrives with a current status: GROUNDED (asserted) or CANDIDATE (needs testing), and its evidence. Assign exactly one verdict per link:
- "confirmed": a GROUNDED link whose evidence withstands the attack. It stays grounded.
- "promoted": a CANDIDATE link whose evidence actually holds up under attack. It earns grounded status.
- "demoted": a GROUNDED link whose evidence does NOT withstand the attack. It falls to candidate.
- "rejected": the link is superficial (coincidence / truism / loose analogy). It is not a real recurrence at all, at either status.

Rules:
- Every verdict MUST cite the specific evidence and say concretely WHY the link survives or falls. No hand-waving.
- Do not be lenient to be agreeable, and do not reject for sport. Calibration is the point: strong shared-method links (the same named algorithm used in both) should survive; truisms and coincidences should fall.
- Judge only the evidence and library material provided. Do not invent evidence.

Return ONLY valid JSON (no markdown, no commentary):
{ "verdicts": [ { "link_id": "<id>", "verdict": "confirmed|promoted|demoted|rejected", "rationale": "the skeptic's reasoning, citing the evidence", "confidence": "low|medium|high" } ] }
One verdict per link id provided. Use only the link ids given.`;

// PASS B: conservative. Discover missed connections, grounded, or emit nothing.
const DISCOVERY_SYSTEM_PROMPT = `You are the CROSS-DOMAIN CRITIC for kazi-lab, running the DISCOVERY pass. You look for genuine cross-domain connections that the synthesis MISSED. This pass is conservative: the failure mode is manufacturing connections, so the bar is high.

Emit a connection ONLY if it is grounded in CONCRETE shared methods or findings across at least TWO libraries:
- "method": the same named algorithm/technique appears in two or more libraries (cite the method name in each).
- "claim": the same specific audited finding recurs across libraries (cite the finding id in each).
- "concept": only if it points to underlying method/claim grounding you also cite.

Rules:
- Prefer emitting NOTHING over emitting a stretch. An empty result is a good outcome.
- Do NOT re-report a connection that is already in the existing links provided; a rediscovery is not a discovery.
- Everything you emit is a CANDIDATE (it has not been validated yet).
- evidence.ref must be REAL: a method name that appears in that library, or a finding id given for that library. Never invent.
- No near-universal ML truisms ("pretraining helps", "scaling helps"): those are not specific cross-domain discoveries.

Return ONLY valid JSON (no markdown, no commentary):
{ "links": [ { "level": "method|claim|concept", "summary": "the connection stated plainly", "libraries": ["<name>", "<name>"], "confidence": "low|medium|high", "rationale": "why this is a genuine missed connection", "evidence": [ { "library": "<name>", "kind": "method|finding|claim", "ref": "<method name or finding id>", "excerpt": "the concrete thing" } ] } ] }
If nothing meets the bar, return { "links": [] }.`;

type RawVerdict = {
  link_id?: unknown;
  verdict?: unknown;
  rationale?: unknown;
  confidence?: unknown;
};
type RawEvidence = { library?: unknown; kind?: unknown; ref?: unknown; excerpt?: unknown };
type RawDiscoveredLink = {
  level?: unknown;
  summary?: unknown;
  libraries?: unknown;
  confidence?: unknown;
  rationale?: unknown;
  evidence?: unknown;
};

export type CrossDomainCritiqueResult =
  | { status: "nothing"; reason: string }
  | {
      status: "completed";
      criticRunId: string;
      crossDomainRunId: string;
      verdicts: { confirmed: number; promoted: number; demoted: number; rejected: number };
      grounded: { confirmed: number; demoted: number; rejected: number };
      candidate: { promoted: number; demoted: number; rejected: number };
      discovered: number;
      droppedVerdicts: number;
      droppedDiscovered: number;
      notes: string | null;
    }
  | { status: "failed"; criticRunId: string; error: string };

type LinkRow = {
  id: string;
  level: string;
  summary: string;
  libraryIds: string[];
  confidence: string | null;
  isCandidate: boolean;
  source: string;
};
type EvidenceRow = {
  linkId: string;
  libraryId: string;
  evidenceKind: string;
  evidenceRef: string;
  excerpt: string | null;
};

// A readable block describing one link and its evidence for the validator. For a
// finding evidence item it appends the finding text + Critic audit status.
function linkDoc(
  link: LinkRow,
  evidence: EvidenceRow[],
  byId: Map<string, LibraryAssembly>,
): string {
  const libName = (id: string) => byId.get(id)?.name ?? "unknown";
  const status = link.isCandidate ? "CANDIDATE" : "GROUNDED";
  const evLines = evidence.map((e) => {
    const a = byId.get(e.libraryId);
    let extra = "";
    if (e.evidenceKind === "finding" && a) {
      const f = a.findings.find((x) => x.id === e.evidenceRef);
      if (f) extra = ` [finding audit: ${f.audit}] "${f.statement}"`;
    }
    return `  - [${libName(e.libraryId)}] ${e.evidenceKind}: ${e.evidenceRef}${extra}${e.excerpt ? ` :: ${e.excerpt}` : ""}`;
  });
  return `LINK ${link.id} [${status}] level=${link.level} confidence=${link.confidence ?? "?"} source=${link.source}
  summary: ${link.summary}
  spans: ${link.libraryIds.map(libName).join(" + ")}
${evLines.join("\n")}`;
}

// Audit ONE cross-domain run: skeptical validation of its links, then
// conservative discovery of missed connections. Defaults to the latest completed
// cross-domain run. Returns "nothing" (no run created) if there is nothing to audit.
export async function runCrossDomainCritique(
  crossDomainRunId?: string,
): Promise<CrossDomainCritiqueResult> {
  const [cdRun] = crossDomainRunId
    ? await db
        .select({ id: crossDomainRuns.id, scope: crossDomainRuns.scope, status: crossDomainRuns.status })
        .from(crossDomainRuns)
        .where(eq(crossDomainRuns.id, crossDomainRunId))
        .limit(1)
    : await db
        .select({ id: crossDomainRuns.id, scope: crossDomainRuns.scope, status: crossDomainRuns.status })
        .from(crossDomainRuns)
        .where(eq(crossDomainRuns.status, "completed"))
        .orderBy(desc(crossDomainRuns.completedAt))
        .limit(1);
  if (!cdRun || cdRun.status !== "completed") {
    return {
      status: "nothing",
      reason: "No completed cross-domain run to audit. Run cross-domain synthesis first.",
    };
  }

  // The run's links + their evidence.
  const linkRows = (await db
    .select({
      id: crossDomainLinks.id,
      level: crossDomainLinks.level,
      summary: crossDomainLinks.summary,
      libraryIds: crossDomainLinks.libraryIds,
      confidence: crossDomainLinks.confidence,
      isCandidate: crossDomainLinks.isCandidate,
      source: crossDomainLinks.source,
    })
    .from(crossDomainLinks)
    .where(eq(crossDomainLinks.crossDomainRunId, cdRun.id))) as LinkRow[];
  const linkIds = new Set(linkRows.map((l) => l.id));
  const evRows = linkRows.length
    ? ((await db
        .select({
          linkId: crossDomainLinkEvidence.linkId,
          libraryId: crossDomainLinkEvidence.libraryId,
          evidenceKind: crossDomainLinkEvidence.evidenceKind,
          evidenceRef: crossDomainLinkEvidence.evidenceRef,
          excerpt: crossDomainLinkEvidence.excerpt,
        })
        .from(crossDomainLinkEvidence)
        .where(inArray(crossDomainLinkEvidence.linkId, linkRows.map((l) => l.id)))) as EvidenceRow[])
    : [];
  const evByLink = new Map<string, EvidenceRow[]>();
  for (const e of evRows) {
    const arr = evByLink.get(e.linkId) ?? [];
    arr.push(e);
    evByLink.set(e.linkId, arr);
  }

  // Reassemble the per-library material for the run's scope (same grounding data
  // the synthesis used), so discovery grounds against the identical checks.
  const scopeLibs = await db
    .select({ id: libraries.id, name: libraries.name })
    .from(libraries)
    .where(inArray(libraries.id, cdRun.scope.length ? cdRun.scope : ["00000000-0000-0000-0000-000000000000"]));
  const assemblies: LibraryAssembly[] = [];
  for (const lib of scopeLibs) {
    const a = await assembleLibrary(lib);
    if (a) assemblies.push(a);
  }
  const byId = new Map(assemblies.map((a) => [a.id, a]));
  const byName = new Map(assemblies.map((a) => [a.name, a]));

  const libDoc = assemblies.map(libraryDoc).join("\n\n");
  const existingLinksDoc = linkRows.length
    ? linkRows.map((l) => linkDoc(l, evByLink.get(l.id) ?? [], byId)).join("\n\n")
    : "(no links in this run)";

  // Create the critic run row up front so a failure is visible.
  const [run] = await db
    .insert(crossDomainCriticRuns)
    .values({ crossDomainRunId: cdRun.id, model: MODEL, status: "running" })
    .returning({ id: crossDomainCriticRuns.id });
  const criticRunId = run.id;

  try {
    const client = new Anthropic();

    // --- PASS A: skeptical validation ------------------------------------
    const validationTokens = Math.min(
      VALIDATION_BASE_TOKENS + linkRows.length * VALIDATION_TOKENS_PER_LINK,
      MAX_OUTPUT_CAP,
    );
    const validationUser = `Library material (the grounding the links rest on):

${libDoc}

=== LINKS TO ATTACK ===
${existingLinksDoc}`;

    let droppedVerdicts = 0;
    const verdictValues: {
      criticRunId: string;
      linkId: string;
      verdict: (typeof VERDICTS)[number];
      rationale: string | null;
      confidence: (typeof CONFIDENCES)[number] | null;
    }[] = [];

    if (linkRows.length > 0) {
      const vResp = await client.messages
        .stream({
          model: MODEL,
          max_tokens: validationTokens,
          system: VALIDATION_SYSTEM_PROMPT,
          messages: [{ role: "user", content: validationUser }],
        })
        .finalMessage();
      const vTruncated = vResp.stop_reason === "max_tokens";
      const vBlock = vResp.content.find((b) => b.type === "text");
      const vRaw = vBlock && vBlock.type === "text" ? vBlock.text : "";
      let vParsed: { verdicts?: RawVerdict[] };
      try {
        vParsed = JSON.parse(extractJsonObject(vRaw)) as { verdicts?: RawVerdict[] };
      } catch (e) {
        if (vTruncated) {
          throw new Error(
            `Validation output truncated (hit the ${validationTokens}-token ceiling); JSON incomplete, nothing written.`,
          );
        }
        throw new Error(`Failed to parse validation JSON: ${(e as Error).message}`);
      }
      const seen = new Set<string>();
      for (const v of vParsed.verdicts ?? []) {
        const id = str(v.link_id) ?? "";
        const verdict = oneOf(v.verdict, VERDICTS);
        // id-validation guard: drop hallucinated / out-of-run / duplicate ids.
        if (!linkIds.has(id) || !verdict || seen.has(id)) {
          droppedVerdicts++;
          continue;
        }
        seen.add(id);
        verdictValues.push({
          criticRunId,
          linkId: id,
          verdict,
          rationale: str(v.rationale),
          confidence: oneOf(v.confidence, CONFIDENCES),
        });
      }
    }

    // --- PASS B: conservative discovery ----------------------------------
    let droppedDiscovered = 0;
    type DiscoveredInsert = {
      level: (typeof LEVELS)[number];
      summary: string;
      libraryIds: string[];
      confidence: (typeof CONFIDENCES)[number] | null;
      rationale: string | null;
      evidence: { libraryId: string; evidenceKind: (typeof KINDS)[number]; evidenceRef: string; excerpt: string | null }[];
    };
    const discovered: DiscoveredInsert[] = [];

    if (assemblies.length >= 2) {
      const itemCount = assemblies.reduce((n, a) => n + a.findings.length + a.methods.length, 0);
      const discoveryTokens = Math.min(
        DISCOVERY_BASE_TOKENS + itemCount * DISCOVERY_TOKENS_PER_ITEM,
        MAX_OUTPUT_CAP,
      );
      const discoveryUser = `Library material:

${libDoc}

=== EXISTING LINKS (do NOT rediscover these) ===
${existingLinksDoc}`;

      const dResp = await client.messages
        .stream({
          model: MODEL,
          max_tokens: discoveryTokens,
          system: DISCOVERY_SYSTEM_PROMPT,
          messages: [{ role: "user", content: discoveryUser }],
        })
        .finalMessage();
      const dTruncated = dResp.stop_reason === "max_tokens";
      const dBlock = dResp.content.find((b) => b.type === "text");
      const dRaw = dBlock && dBlock.type === "text" ? dBlock.text : "";
      let dParsed: { links?: RawDiscoveredLink[] };
      try {
        dParsed = JSON.parse(extractJsonObject(dRaw)) as { links?: RawDiscoveredLink[] };
      } catch (e) {
        if (dTruncated) {
          throw new Error(
            `Discovery output truncated (hit the ${discoveryTokens}-token ceiling); JSON incomplete, nothing written.`,
          );
        }
        throw new Error(`Failed to parse discovery JSON: ${(e as Error).message}`);
      }

      // Existing (level, sorted-library-set) + evidence refs, to skip rediscoveries.
      const existingKeys = new Set(
        linkRows.map((l) => `${l.level}|${[...l.libraryIds].sort().join(",")}`),
      );

      for (const raw of dParsed.links ?? []) {
        const level = oneOf(raw.level, LEVELS);
        const summary = str(raw.summary);
        if (!level || !summary) {
          droppedDiscovered++;
          continue;
        }
        const evidence: DiscoveredInsert["evidence"] = [];
        for (const ev of Array.isArray(raw.evidence) ? (raw.evidence as RawEvidence[]) : []) {
          const libName = str(ev.library);
          const kind = oneOf(ev.kind, KINDS);
          const ref = str(ev.ref);
          const a = libName ? byName.get(libName) : undefined;
          if (!a || !kind || !ref) continue;
          // SAME evidence-resolution check as synthesis.
          const { valid } = resolveEvidenceRef(a, kind, ref);
          if (!valid) continue;
          evidence.push({ libraryId: a.id, evidenceKind: kind, evidenceRef: ref, excerpt: str(ev.excerpt) });
        }
        const coveredLibs = [...new Set(evidence.map((e) => e.libraryId))];
        if (coveredLibs.length < 2) {
          droppedDiscovered++;
          continue;
        }
        // Drop a rediscovery of an existing link (same level + same library set).
        const key = `${level}|${[...coveredLibs].sort().join(",")}`;
        if (existingKeys.has(key)) {
          droppedDiscovered++;
          continue;
        }
        discovered.push({
          level,
          summary,
          libraryIds: coveredLibs,
          confidence: oneOf(raw.confidence, CONFIDENCES),
          rationale: str(raw.rationale),
          evidence,
        });
      }
    }

    const noteParts: string[] = [];
    if (droppedVerdicts) noteParts.push(`Dropped ${droppedVerdicts} verdict(s) with invalid link ids.`);
    if (droppedDiscovered) noteParts.push(`Dropped ${droppedDiscovered} discovered link(s) that did not ground or duplicated an existing link.`);

    // Write verdicts + discovered links/evidence + completion atomically.
    await db.transaction(async (tx) => {
      if (verdictValues.length) await tx.insert(linkVerdicts).values(verdictValues);
      for (const d of discovered) {
        const [inserted] = await tx
          .insert(crossDomainLinks)
          .values({
            crossDomainRunId: cdRun.id,
            level: d.level,
            summary: d.summary,
            libraryIds: d.libraryIds,
            confidence: d.confidence,
            // Server-side enforcement: discovery NEVER asserts.
            isCandidate: true,
            source: "discovery",
            rationale: d.rationale,
          })
          .returning({ id: crossDomainLinks.id });
        if (d.evidence.length) {
          await tx.insert(crossDomainLinkEvidence).values(
            d.evidence.map((e) => ({
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
        .update(crossDomainCriticRuns)
        .set({ status: "completed", completedAt: new Date(), notes: noteParts.length ? noteParts.join(" ") : null })
        .where(eq(crossDomainCriticRuns.id, criticRunId));
    });

    // Tally the distribution, split by the link's prior status.
    const isCandidateById = new Map(linkRows.map((l) => [l.id, l.isCandidate]));
    const verdicts = { confirmed: 0, promoted: 0, demoted: 0, rejected: 0 };
    const grounded = { confirmed: 0, demoted: 0, rejected: 0 };
    const candidate = { promoted: 0, demoted: 0, rejected: 0 };
    for (const v of verdictValues) {
      verdicts[v.verdict]++;
      const wasCandidate = isCandidateById.get(v.linkId) ?? false;
      if (wasCandidate) {
        if (v.verdict === "promoted") candidate.promoted++;
        else if (v.verdict === "demoted") candidate.demoted++;
        else if (v.verdict === "rejected") candidate.rejected++;
      } else {
        if (v.verdict === "confirmed") grounded.confirmed++;
        else if (v.verdict === "demoted") grounded.demoted++;
        else if (v.verdict === "rejected") grounded.rejected++;
      }
    }

    return {
      status: "completed",
      criticRunId,
      crossDomainRunId: cdRun.id,
      verdicts,
      grounded,
      candidate,
      discovered: discovered.length,
      droppedVerdicts,
      droppedDiscovered,
      notes: noteParts.length ? noteParts.join(" ") : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(crossDomainCriticRuns)
      .set({ status: "failed", completedAt: new Date(), error: message })
      .where(eq(crossDomainCriticRuns.id, criticRunId));
    throw error;
  }
}
