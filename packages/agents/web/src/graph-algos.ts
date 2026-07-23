import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import betweenness from "graphology-metrics/centrality/betweenness";

// Deterministic graph algorithms for the research web. Everything here is pure
// (no db, no LLM) and unit-tested (graph-algos.test.ts). The LLM never runs any
// of this; it only labels communities and proposes crossovers downstream. The
// discipline is Swanson's ABC literature-based discovery and Gentner's
// structure mapping wired into deterministic scoring: the machine computes,
// grounds, and penalizes; it never asserts.

// A small, seedable PRNG (mulberry32) so Louvain is reproducible: same seed +
// same graph construction order = same partition. graphology-communities-louvain
// routes all its randomness through the rng we pass.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cosine similarity between two equal-length vectors.
export function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Conservative singular fold on the LAST word only (under-merge over over-merge):
// "networks" -> "network", "categories" -> "category", but "analysis"/"process"
// stay put. Deliberately crude and documented; the embedding merge does the rest.
function singularize(w: string): string {
  if (w.length <= 4) return w;
  if (w.endsWith("ss") || w.endsWith("us") || w.endsWith("is") || w.endsWith("ous")) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("ches") || w.endsWith("shes") || w.endsWith("xes") || w.endsWith("ses") || w.endsWith("zes")) {
    return w.slice(0, -2);
  }
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}

// String-level canonicalization of a raw key term: lowercase, trim, fold
// hyphens/underscores/slashes to spaces, collapse whitespace, singular-fold the
// last word. Two terms that map to the same string are the same concept before
// the embedding merge even runs.
export function normalizeTerm(raw: string): string {
  let s = raw.toLowerCase().trim();
  s = s.replace(/[-_/]+/g, " ");
  s = s.replace(/[^a-z0-9 ]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return s;
  const words = s.split(" ");
  words[words.length - 1] = singularize(words[words.length - 1]);
  return words.join(" ");
}

// Merge terms whose embedding cosine similarity >= threshold via union-find.
// Input is the DISTINCT normalized terms and their vectors (index-aligned).
// Returns groups as arrays of indices; the threshold is deliberately high
// (default 0.90) to under-merge. Deterministic: pairs scanned in index order.
export function mergeTermsByEmbedding(vectors: number[][], threshold: number): number[][] {
  const n = vectors.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (x: number, y: number) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[Math.max(rx, ry)] = Math.min(rx, ry);
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosineSim(vectors[i], vectors[j]) >= threshold) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = groups.get(r) ?? [];
    arr.push(i);
    groups.set(r, arr);
  }
  // Deterministic order: by smallest member index.
  return [...groups.values()].sort((a, b) => a[0] - b[0]);
}

// The paper-projection edge weight between two papers, combining the semantic
// similarity with counts of shared concepts/methods/datasets, claim-relation
// links between their claims, and citations. All weights documented in the
// engine's default params.
export type PairSignals = {
  semantic: number; // best cosine similarity (0 if not a kNN neighbor)
  sharedConcepts: number;
  sharedMethods: number;
  sharedDatasets: number;
  claimLinks: number; // claim_relation edges between the two papers' claims
  citations: number; // directed citations either way
};
export type WeightVector = {
  semantic: number;
  concept: number;
  method: number;
  dataset: number;
  claims: number;
  cite: number;
};
export function projectionWeight(s: PairSignals, w: WeightVector): number {
  return (
    s.semantic * w.semantic +
    s.sharedConcepts * w.concept +
    s.sharedMethods * w.method +
    s.sharedDatasets * w.dataset +
    s.claimLinks * w.claims +
    s.citations * w.cite
  );
}

// One intermediate B on an A-C ABC path: how many distinct papers support the
// A-B leg and the B-C leg (capped), and B's degree (the log penalty suppresses
// ubiquitous-B truisms).
export type BContribution = { sAB: number; sBC: number; degreeB: number };
export const ABC_SUPPORT_CAP = 5;
// SCORE(A,C) = sum over B of [ min(s(A,B),cap) x min(s(B,C),cap) / log2(2 + degree(B)) ].
// A candidate connected only through a single ubiquitous B scores LOW; one
// connected through several specific Bs scores higher. Deterministic and
// unit-tested including the ubiquitous-B suppression.
export function scoreABC(contributions: BContribution[], cap = ABC_SUPPORT_CAP): number {
  let score = 0;
  for (const c of contributions) {
    const sAB = Math.min(c.sAB, cap);
    const sBC = Math.min(c.sBC, cap);
    score += (sAB * sBC) / Math.log2(2 + c.degreeB);
  }
  return score;
}

// Adjusted Rand Index between two labelings of the same items (emergent
// communities vs declared libraries). 1.0 = identical partitions; ~0 = chance;
// negative = worse than chance. Standard combinatorial formula.
export function adjustedRandIndex(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("ARI: labelings must be equal length");
  const n = a.length;
  if (n === 0) return 1;
  const comb2 = (x: number) => (x * (x - 1)) / 2;
  const contingency = new Map<string, number>();
  const rowSums = new Map<number, number>();
  const colSums = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const key = `${a[i]}|${b[i]}`;
    contingency.set(key, (contingency.get(key) ?? 0) + 1);
    rowSums.set(a[i], (rowSums.get(a[i]) ?? 0) + 1);
    colSums.set(b[i], (colSums.get(b[i]) ?? 0) + 1);
  }
  let sumIndex = 0;
  for (const v of contingency.values()) sumIndex += comb2(v);
  let sumA = 0;
  for (const v of rowSums.values()) sumA += comb2(v);
  let sumB = 0;
  for (const v of colSums.values()) sumB += comb2(v);
  const total = comb2(n);
  const expected = total === 0 ? 0 : (sumA * sumB) / total;
  const max = (sumA + sumB) / 2;
  if (max - expected === 0) return 1; // both trivial partitions
  return (sumIndex - expected) / (max - expected);
}

// Inverse document frequency, clamped non-negative. Used to down-weight
// concept-sharing edges: a concept in almost every paper contributes ~0, a rare
// shared concept contributes a lot. This fixes the projection-density problem
// where ubiquitous concepts connected nearly every pair of papers.
export function idf(df: number, n: number): number {
  if (n <= 0) return 0;
  return Math.max(0, Math.log(n / (1 + df)));
}

// Domain-distance factor for ABC/bridge ranking. simAC is the cosine similarity
// between two communities' embedding centroids (in [-1, 1]). Candidates spanning
// DISTANT (low-similarity) communities score higher: this is the mechanism that
// hunts for real links between genuinely different fields rather than
// near-neighbors. Always >= 1 (never suppresses; only rewards distance).
export function domainDistanceFactor(simAC: number, alpha = 1): number {
  const dist = Math.max(0, 1 - simAC); // 0 (identical) .. 2 (opposite)
  return 1 + alpha * dist;
}

export type WeightedEdge = { a: string; b: string; weight: number };

// Build an undirected weighted graphology graph, summing parallel edge weights.
function buildGraph(nodes: string[], edges: WeightedEdge[]): Graph {
  const g = new Graph({ type: "undirected", multi: false });
  for (const n of nodes) if (!g.hasNode(n)) g.addNode(n);
  for (const e of edges) {
    if (e.a === e.b) continue;
    if (!g.hasNode(e.a) || !g.hasNode(e.b)) continue;
    if (g.hasEdge(e.a, e.b)) {
      g.setEdgeAttribute(e.a, e.b, "weight", (g.getEdgeAttribute(e.a, e.b, "weight") as number) + e.weight);
    } else {
      g.addEdge(e.a, e.b, { weight: e.weight });
    }
  }
  return g;
}

// Seeded Louvain community detection on a weighted graph. Returns node -> integer
// community. Isolated nodes (no edges) each get their own singleton community.
export function louvainPartition(
  nodes: string[],
  edges: WeightedEdge[],
  resolution: number,
  seed: number,
): Record<string, number> {
  const g = buildGraph(nodes, edges);
  if (g.size === 0) {
    const m: Record<string, number> = {};
    nodes.forEach((n, i) => (m[n] = i));
    return m;
  }
  return louvain(g, {
    resolution,
    rng: mulberry32(seed),
    getEdgeWeight: "weight",
  });
}

// Brandes betweenness centrality (weighted, normalized) on the projection.
export function computeBetweenness(nodes: string[], edges: WeightedEdge[]): Record<string, number> {
  const g = buildGraph(nodes, edges);
  if (g.order === 0) return {};
  return betweenness(g, { getEdgeWeight: "weight", normalized: true });
}
