// Deterministic meta-analysis pooling over paper_metrics rows. This is the whole
// quantitative half of the Experimentalist: NO LLM computes any number here. All
// functions are pure and unit-tested (see pooling.test.ts). The pooling respects
// the conditions discipline (per-protocol / per-flavor slices never merge), the
// self-report preference, and surfaces flagged value conflicts instead of
// silently resolving them, mirroring the cleaned metric-pool logic.

export type MetricRow = {
  paperId: string;
  paperLabel: string;
  methodName: string;
  isSelf: boolean;
  value: number;
  datasetCanon: string;
  metricCanon: string;
  taskCanon: string;
  conditions: string; // normalized; "(default)" when the source reports none
  dispersion: string | null;
};

// Two values for the same (method, key, conditions) within this tolerance are
// the same result (rounding noise). A larger gap is a genuine disagreement and
// is flagged, never silently merged.
export const CONFLICT_TOLERANCE = 0.15;
export const DEFAULT_CONDITIONS = "(default)";

// Metrics where a LOWER value is better. Everything else (accuracy, mIoU, F1,
// PSNR, SSIM, AP, AR, mAP, FPS, IoU, ...) is higher-is-better.
const LOWER_BETTER = new Set([
  "error_rate",
  "latency",
  "gpu_memory",
  "params",
  "model_size",
  "flops",
  "chamfer_distance",
  "emd",
  "lpips",
  "number of gaussians",
]);
export function higherIsBetter(metricCanon: string): boolean {
  return !LOWER_BETTER.has(metricCanon.trim().toLowerCase());
}

// Parse a reported dispersion string ("0.0249", "+-0.3", "1.2%") to a positive
// number, or null. Never invents a value.
export function parseDispersion(d: string | null): number | null {
  if (!d) return null;
  const m = d.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Math.abs(Number(m[0]));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type ValueGroup = {
  value: number;
  papers: string[];
  selfPapers: string[];
};
export type MethodPool = {
  method: string;
  pooledValue: number; // self-preferred, else median of distinct group values
  pooledFromSelf: boolean;
  conflict: boolean; // more than one distinct value for this method in this slice
  values: ValueGroup[];
};
export type RankEntry = { method: string; meanRank: number; medianRank: number; nPapers: number };
export type WinEntry = { method: string; wins: number; losses: number; winRate: number };
export type Conflict = { method: string; values: number[] };
export type VarianceSubset = {
  weightedMean: number;
  contributing: { method: string; value: number; std: number; paper: string }[];
  note: string;
} | null;

export type SlicePool = {
  datasetCanon: string;
  metricCanon: string;
  taskCanon: string;
  conditions: string;
  higherIsBetter: boolean;
  nMethods: number;
  nPapers: number;
  methods: MethodPool[]; // best/median pooled, self-preferred
  ranks: RankEntry[];
  winRates: WinEntry[];
  conflicts: Conflict[];
  varianceSubset: VarianceSubset;
};

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Rank values within one paper (1 = best per polarity); ties share the average
// rank. Returns a method -> rank map for that paper.
function rankWithinPaper(
  entries: { method: string; value: number }[],
  higher: boolean,
): Map<string, number> {
  const sorted = [...entries].sort((a, b) => (higher ? b.value - a.value : a.value - b.value));
  const ranks = new Map<string, number>();
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    // group ties (equal value)
    while (j + 1 < sorted.length && sorted[j + 1].value === sorted[i].value) j++;
    const avgRank = (i + 1 + (j + 1)) / 2; // average of positions i+1..j+1
    for (let k = i; k <= j; k++) ranks.set(sorted[k].method, avgRank);
    i = j + 1;
  }
  return ranks;
}

// Pool one slice: rows must all share (dataset, metric, task, conditions).
export function poolSlice(rows: MetricRow[]): SlicePool {
  const first = rows[0];
  const higher = higherIsBetter(first.metricCanon);

  // method -> value groups (collapse within tolerance), tracking self reports.
  const byMethod = new Map<string, ValueGroup[]>();
  for (const r of rows) {
    let groups = byMethod.get(r.methodName);
    if (!groups) {
      groups = [];
      byMethod.set(r.methodName, groups);
    }
    let g = groups.find((x) => Math.abs(x.value - r.value) <= CONFLICT_TOLERANCE);
    if (!g) {
      g = { value: r.value, papers: [], selfPapers: [] };
      groups.push(g);
    }
    if (!g.papers.includes(r.paperLabel)) g.papers.push(r.paperLabel);
    if (r.isSelf && !g.selfPapers.includes(r.paperLabel)) g.selfPapers.push(r.paperLabel);
  }

  const methods: MethodPool[] = [];
  const conflicts: Conflict[] = [];
  for (const [method, groups] of byMethod) {
    const selfGroup = groups.find((g) => g.selfPapers.length > 0);
    const pooledValue = selfGroup ? selfGroup.value : median(groups.map((g) => g.value));
    const conflict = groups.length > 1;
    methods.push({
      method,
      pooledValue,
      pooledFromSelf: !!selfGroup,
      conflict,
      values: groups,
    });
    if (conflict) {
      conflicts.push({ method, values: groups.map((g) => g.value).sort((a, b) => a - b) });
    }
  }
  methods.sort((a, b) => (higher ? b.pooledValue - a.pooledValue : a.pooledValue - b.pooledValue));

  // Per-paper representative value for each method (median if a paper has more
  // than one row for the same method in this slice).
  const paperMethodVals = new Map<string, Map<string, number[]>>();
  for (const r of rows) {
    let pm = paperMethodVals.get(r.paperLabel);
    if (!pm) {
      pm = new Map();
      paperMethodVals.set(r.paperLabel, pm);
    }
    const arr = pm.get(r.methodName) ?? [];
    arr.push(r.value);
    pm.set(r.methodName, arr);
  }

  // Rank aggregation across papers.
  const rankLists = new Map<string, number[]>();
  // Pairwise win/loss across co-reported methods within each paper.
  const wins = new Map<string, number>();
  const losses = new Map<string, number>();
  for (const [, pm] of paperMethodVals) {
    const entries = [...pm.entries()].map(([method, vals]) => ({ method, value: median(vals) }));
    const ranks = rankWithinPaper(entries, higher);
    for (const [method, rank] of ranks) {
      const list = rankLists.get(method) ?? [];
      list.push(rank);
      rankLists.set(method, list);
    }
    for (let a = 0; a < entries.length; a++) {
      for (let b = a + 1; b < entries.length; b++) {
        const ea = entries[a];
        const eb = entries[b];
        if (ea.value === eb.value) continue; // tie: no win/loss
        const aWins = higher ? ea.value > eb.value : ea.value < eb.value;
        const winner = aWins ? ea.method : eb.method;
        const loser = aWins ? eb.method : ea.method;
        wins.set(winner, (wins.get(winner) ?? 0) + 1);
        losses.set(loser, (losses.get(loser) ?? 0) + 1);
      }
    }
  }
  const ranksOut: RankEntry[] = [...rankLists.entries()]
    .map(([method, list]) => ({
      method,
      meanRank: list.reduce((s, x) => s + x, 0) / list.length,
      medianRank: median(list),
      nPapers: list.length,
    }))
    .sort((a, b) => a.meanRank - b.meanRank);
  const winRates: WinEntry[] = [...byMethod.keys()]
    .map((method) => {
      const w = wins.get(method) ?? 0;
      const l = losses.get(method) ?? 0;
      return { method, wins: w, losses: l, winRate: w + l > 0 ? w / (w + l) : 0 };
    })
    .sort((a, b) => b.winRate - a.winRate);

  // Variance-weighted subset: ONLY if >=3 rows on this slice report dispersion.
  const dispRows = rows
    .map((r) => ({ method: r.methodName, value: r.value, std: parseDispersion(r.dispersion), paper: r.paperLabel }))
    .filter((r): r is { method: string; value: number; std: number; paper: string } => r.std !== null);
  let varianceSubset: VarianceSubset = null;
  if (dispRows.length >= 3) {
    const sumW = dispRows.reduce((s, r) => s + 1 / (r.std * r.std), 0);
    const weightedMean = dispRows.reduce((s, r) => s + (1 / (r.std * r.std)) * r.value, 0) / sumW;
    varianceSubset = {
      weightedMean,
      contributing: dispRows,
      note: `Subset analysis: inverse-variance weighted mean over the ${dispRows.length} results on this key that report dispersion. Not a per-method estimate; provided only because this slice meets the >=3-dispersion-rows bar.`,
    };
  }

  const nPapers = new Set(rows.map((r) => r.paperLabel)).size;
  return {
    datasetCanon: first.datasetCanon,
    metricCanon: first.metricCanon,
    taskCanon: first.taskCanon,
    conditions: first.conditions,
    higherIsBetter: higher,
    nMethods: byMethod.size,
    nPapers,
    methods,
    ranks: ranksOut,
    winRates,
    conflicts,
    varianceSubset,
  };
}

// Group rows into (dataset, metric, task, conditions) slices and pool each. Only
// slices with at least `minPapers` distinct papers are returned (cross-paper
// meta-analysis needs more than one paper); the count of single-paper slices
// dropped is returned so nothing is silently hidden.
export function computePools(
  rows: MetricRow[],
  minPapers = 2,
): { slices: SlicePool[]; droppedSinglePaper: number } {
  const byKey = new Map<string, MetricRow[]>();
  for (const r of rows) {
    const key = `${r.datasetCanon}|||${r.metricCanon}|||${r.taskCanon}|||${r.conditions}`;
    const arr = byKey.get(key) ?? [];
    arr.push(r);
    byKey.set(key, arr);
  }
  const slices: SlicePool[] = [];
  let droppedSinglePaper = 0;
  for (const [, group] of byKey) {
    const nPapers = new Set(group.map((r) => r.paperLabel)).size;
    if (nPapers < minPapers) {
      droppedSinglePaper++;
      continue;
    }
    slices.push(poolSlice(group));
  }
  // Order by evidence weight: more papers, then more methods.
  slices.sort((a, b) => b.nPapers - a.nPapers || b.nMethods - a.nMethods);
  return { slices, droppedSinglePaper };
}
