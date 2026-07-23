import { test } from "node:test";
import assert from "node:assert/strict";
import { intraInterRatio, selectProjection, silhouetteScore } from "./projection-select";
import { mulberry32 } from "./graph-algos";

// Deterministic synthetic clusters (same generator style as tsne.test.ts).
function makeClusters(dim: number, perCluster: number, spread: number, sep: number): { X: number[][]; labels: number[] } {
  const rand = mulberry32(4242);
  const gauss = () => {
    const u1 = Math.max(rand(), 1e-9);
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const centers = [
    new Array(dim).fill(0),
    new Array(dim).fill(0).map((_, i) => (i === 0 ? sep : 0)),
    new Array(dim).fill(0).map((_, i) => (i === 1 ? sep : 0)),
  ];
  const X: number[][] = [];
  const labels: number[] = [];
  for (let c = 0; c < 3; c++) {
    for (let k = 0; k < perCluster; k++) {
      X.push(centers[c].map((m) => m + gauss() * spread));
      labels.push(c);
    }
  }
  return { X, labels };
}

// FIXTURE: silhouette is high for separated clusters, low for mixed points.
test("silhouette: separated clusters score high, shuffled labels score low", () => {
  const { X, labels } = makeClusters(3, 12, 0.5, 25);
  const separated = silhouetteScore(X, labels);
  assert.ok(separated > 0.7, `separated clusters should score > 0.7, got ${separated.toFixed(3)}`);
  // Same points with rotated (wrong) labels: the structure no longer matches.
  const wrong = labels.map((l) => (l + 1) % 3);
  const rotated = silhouetteScore(
    X,
    labels.map((l, i) => (i % 2 === 0 ? l : wrong[i])),
  );
  assert.ok(rotated < separated, "mislabeled points must lower the silhouette");
});

// FIXTURE: silhouette edge cases (singletons, unlabeled, single cluster).
test("silhouette: handles singletons, unlabeled points, and a single cluster", () => {
  const Y = [[0, 0, 0], [1, 0, 0], [10, 0, 0]];
  // Singleton cluster contributes s = 0, not NaN.
  const withSingleton = silhouetteScore(Y, [0, 0, 1]);
  assert.ok(Number.isFinite(withSingleton));
  // Unlabeled (-1) points are excluded; one remaining cluster returns 0.
  assert.equal(silhouetteScore(Y, [0, 0, -1]), 0);
});

// FIXTURE: the intra/inter ratio is small for separated clusters.
test("intraInterRatio: separated clusters have ratio well under 1", () => {
  const { X, labels } = makeClusters(3, 10, 0.5, 25);
  assert.ok(intraInterRatio(X, labels) < 0.3);
});

// FIXTURE: the sweep is deterministic given a seed and picks a real grid entry.
test("selectProjection: deterministic given a seed, chosen entry maximizes silhouette", () => {
  const { X, labels } = makeClusters(8, 8, 0.6, 20);
  const a = selectProjection(X, labels, 7, { iterations: 150 });
  const b = selectProjection(X, labels, 7, { iterations: 150 });
  assert.deepEqual(a.chosen, b.chosen);
  assert.deepEqual(a.coords, b.coords);
  // The chosen silhouette is the max across the recorded sweep.
  const max = Math.max(...a.entries.map((e) => e.silhouette));
  assert.equal(a.chosen.silhouette, max);
  // Perplexity candidates were clamped to the well-posedness cap.
  const cap = Math.floor((X.length - 1) / 3);
  for (const e of a.entries) assert.ok(e.perplexity <= cap);
});
