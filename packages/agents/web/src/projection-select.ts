import { tsne, type TsneParams } from "./tsne";

// Projection parameter selection by COMPUTED separation metric, not by eye.
// For each candidate (perplexity, earlyExaggeration) pair we run the seeded
// t-SNE and score how well the 3D coordinates separate the (already computed)
// Louvain communities. The chosen setting maximizes the mean silhouette score;
// the full sweep is recorded on the web run so the choice is auditable.
// Deterministic: same inputs + same seed = same sweep = same choice.

// Candidate grid. Perplexities are clamped to the t-SNE well-posedness cap
// ((n - 1) / 3) and deduplicated, so small corpora sweep a smaller grid.
export const SWEEP_PERPLEXITIES = [10, 20, 30, 45];
export const SWEEP_EARLY_EXAGGERATIONS = [4, 12];

export type SweepEntry = {
  perplexity: number;
  earlyExaggeration: number;
  silhouette: number;
  intraInterRatio: number; // mean intra-community distance / mean inter-community distance (lower is better)
};

export type ProjectionSelection = {
  coords: number[][];
  chosen: SweepEntry;
  entries: SweepEntry[];
};

function euclidean(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

// Mean silhouette score of a labeled point set. Standard definition: for point
// i, a(i) = mean distance to its own cluster's other members, b(i) = min over
// other clusters of the mean distance to that cluster, s(i) = (b - a) / max(a, b).
// Points in singleton clusters get s = 0 (the sklearn convention). Labels < 0
// are treated as unlabeled and excluded. Returns 0 when fewer than 2 clusters.
export function silhouetteScore(Y: number[][], labels: number[]): number {
  if (Y.length !== labels.length) throw new Error("silhouette: points and labels must be equal length");
  const idxs = labels.map((l, i) => (l >= 0 ? i : -1)).filter((i) => i >= 0);
  const clusters = new Map<number, number[]>();
  for (const i of idxs) {
    const arr = clusters.get(labels[i]) ?? [];
    arr.push(i);
    clusters.set(labels[i], arr);
  }
  if (clusters.size < 2) return 0;
  let sum = 0;
  let count = 0;
  for (const i of idxs) {
    const own = clusters.get(labels[i])!;
    if (own.length === 1) {
      count++; // singleton: s = 0 by convention
      continue;
    }
    let a = 0;
    for (const j of own) if (j !== i) a += euclidean(Y[i], Y[j]);
    a /= own.length - 1;
    let b = Infinity;
    for (const [label, members] of clusters) {
      if (label === labels[i]) continue;
      let m = 0;
      for (const j of members) m += euclidean(Y[i], Y[j]);
      m /= members.length;
      if (m < b) b = m;
    }
    const denom = Math.max(a, b);
    sum += denom > 0 ? (b - a) / denom : 0;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

// Mean intra-community distance over mean inter-community distance (secondary,
// reported alongside silhouette). Lower is better.
export function intraInterRatio(Y: number[][], labels: number[]): number {
  let intraSum = 0;
  let intraN = 0;
  let interSum = 0;
  let interN = 0;
  for (let i = 0; i < Y.length; i++) {
    if (labels[i] < 0) continue;
    for (let j = i + 1; j < Y.length; j++) {
      if (labels[j] < 0) continue;
      const d = euclidean(Y[i], Y[j]);
      if (labels[i] === labels[j]) {
        intraSum += d;
        intraN++;
      } else {
        interSum += d;
        interN++;
      }
    }
  }
  if (intraN === 0 || interN === 0) return 1;
  return intraSum / intraN / (interSum / interN);
}

// Run the sweep and pick the setting with the highest silhouette. Ties break
// deterministically toward the earlier grid entry (lower perplexity first).
// labels align index-wise with X; label < 0 = no community (excluded from the
// metric but still projected).
export function selectProjection(
  X: number[][],
  labels: number[],
  seed: number,
  overrides?: Partial<TsneParams>,
): ProjectionSelection {
  const n = X.length;
  const cap = Math.max(2, Math.floor((n - 1) / 3));
  const perplexities = [...new Set(SWEEP_PERPLEXITIES.map((p) => Math.min(p, cap)))];
  const entries: SweepEntry[] = [];
  let best: { entry: SweepEntry; coords: number[][] } | null = null;
  for (const perplexity of perplexities) {
    for (const earlyExaggeration of SWEEP_EARLY_EXAGGERATIONS) {
      const Y = tsne(X, { ...overrides, seed, perplexity, earlyExaggeration });
      const entry: SweepEntry = {
        perplexity,
        earlyExaggeration,
        silhouette: round4(silhouetteScore(Y, labels)),
        intraInterRatio: round4(intraInterRatio(Y, labels)),
      };
      entries.push(entry);
      if (!best || entry.silhouette > best.entry.silhouette) best = { entry, coords: Y };
    }
  }
  if (!best) {
    // n < 3 never reaches here (callers guard), but stay total: fall back to
    // the default projection with no sweep.
    const Y = tsne(X, { ...overrides, seed });
    const entry: SweepEntry = { perplexity: cap, earlyExaggeration: 12, silhouette: 0, intraInterRatio: 1 };
    return { coords: Y, chosen: entry, entries: [entry] };
  }
  return { coords: best.coords, chosen: best.entry, entries };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
