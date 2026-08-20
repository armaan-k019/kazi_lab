// ---------------------------------------------------------------------------
// Deterministic ABC-candidate grouping. Pure TypeScript, unit-tested, no LLM:
// the lab does not paraphrase its own findings. Candidates that share the same
// unordered community pair, the same set of bridge (B) concepts, AND the same
// evidence-paper set are ONE finding fragmented across concept pairings; they
// collapse into a group. Nothing is discarded: every pairing is nested inside
// its group, sorted by score.
// ---------------------------------------------------------------------------

// Structural input type: the ABC payload shape as stored on web_bridges rows
// and served by /api/web/latest. Extra fields pass through untouched.
export type AbcCandidateLike = {
  score: number;
  payload: {
    a_label: string;
    c_label: string;
    a_community?: number;
    c_community?: number;
    base_score?: number;
    domain_distance_factor?: number;
    community_similarity?: number | null;
    path_evidence?: {
      b_label: string;
      a_leg_papers: { id?: string; title: string }[];
      c_leg_papers: { id?: string; title: string }[];
    }[];
  };
};

export type GroupedPairing = {
  aLabel: string;
  cLabel: string;
  score: number;
  baseScore: number | null;
  // Index into the original candidate array (provenance; nothing is lost).
  sourceIndex: number;
};

export type GroupedFinding = {
  // Unordered community pair, ascending ([a, c] with a <= c); -1 = unassigned.
  communityPair: [number, number];
  bridgeConcepts: string[]; // sorted, deduplicated B terms
  bestScore: number;
  distanceFactor: number | null; // from the best-scoring pairing
  pairings: GroupedPairing[]; // sorted by score desc; length >= 1
  // Distinct evidence papers across both legs, with leg attribution.
  evidence: {
    aPapers: { id: string | null; title: string }[];
    cPapers: { id: string | null; title: string }[];
    distinctPaperCount: number;
  };
  signature: string; // the computed grouping key (debuggable, stable)
};

function sortedUnique(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

// Paper identity for the signature: the id when present, else the title (the
// projection always has ids; titles are the honest fallback, never invented).
function paperKey(p: { id?: string; title: string }): string {
  return p.id ?? `title:${p.title}`;
}

export function candidateSignature(c: AbcCandidateLike): string {
  const a = c.payload.a_community ?? -1;
  const b = c.payload.c_community ?? -1;
  const pair = a <= b ? [a, b] : [b, a];
  const bridges = sortedUnique((c.payload.path_evidence ?? []).map((p) => p.b_label));
  const papers = sortedUnique(
    (c.payload.path_evidence ?? []).flatMap((p) => [...p.a_leg_papers.map(paperKey), ...p.c_leg_papers.map(paperKey)]),
  );
  return JSON.stringify([pair, bridges, papers]);
}

// Group candidates by signature. Groups sort by best score desc; pairings
// within a group sort by score desc. Deterministic for a given input order
// (ties keep first-seen order).
export function groupAbcCandidates(candidates: AbcCandidateLike[]): GroupedFinding[] {
  const groups = new Map<string, GroupedFinding>();
  candidates.forEach((c, i) => {
    const sig = candidateSignature(c);
    const a = c.payload.a_community ?? -1;
    const b = c.payload.c_community ?? -1;
    const pair: [number, number] = a <= b ? [a, b] : [b, a];
    const pairing: GroupedPairing = {
      aLabel: c.payload.a_label,
      cLabel: c.payload.c_label,
      score: c.score,
      baseScore: c.payload.base_score ?? null,
      sourceIndex: i,
    };
    const existing = groups.get(sig);
    if (existing) {
      existing.pairings.push(pairing);
      if (c.score > existing.bestScore) {
        existing.bestScore = c.score;
        existing.distanceFactor = c.payload.domain_distance_factor ?? existing.distanceFactor;
      }
      return;
    }
    // Distinct evidence papers per leg (first-seen order for readability).
    const seenA = new Map<string, { id: string | null; title: string }>();
    const seenC = new Map<string, { id: string | null; title: string }>();
    for (const pth of c.payload.path_evidence ?? []) {
      for (const p of pth.a_leg_papers) if (!seenA.has(paperKey(p))) seenA.set(paperKey(p), { id: p.id ?? null, title: p.title });
      for (const p of pth.c_leg_papers) if (!seenC.has(paperKey(p))) seenC.set(paperKey(p), { id: p.id ?? null, title: p.title });
    }
    const aPapers = [...seenA.values()];
    const cPapers = [...seenC.values()];
    const distinct = new Set([...seenA.keys(), ...seenC.keys()]).size;
    groups.set(sig, {
      communityPair: pair,
      bridgeConcepts: sortedUnique((c.payload.path_evidence ?? []).map((p) => p.b_label)),
      bestScore: c.score,
      distanceFactor: c.payload.domain_distance_factor ?? null,
      pairings: [pairing],
      evidence: { aPapers, cPapers, distinctPaperCount: distinct },
      signature: sig,
    });
  });

  const out = [...groups.values()];
  for (const g of out) g.pairings.sort((x, y) => y.score - x.score);
  out.sort((x, y) => y.bestScore - x.bestScore);
  return out;
}
