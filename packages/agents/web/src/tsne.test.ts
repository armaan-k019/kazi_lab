import { test } from "node:test";
import assert from "node:assert/strict";
import { tsne } from "./tsne";
import { domainDistanceFactor, idf, mulberry32 } from "./graph-algos";

// Build three well-separated Gaussian clusters in high-dim, deterministically.
function threeClusters(dim = 8, perCluster = 10): { X: number[][]; labels: number[] } {
  const rand = mulberry32(99);
  const gauss = () => {
    // Box-Muller from the seeded uniform.
    const u1 = Math.max(rand(), 1e-9);
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const centers = [
    new Array(dim).fill(0),
    new Array(dim).fill(0).map((_, i) => (i === 0 ? 20 : 0)),
    new Array(dim).fill(0).map((_, i) => (i === 1 ? 20 : 0)),
  ];
  const X: number[][] = [];
  const labels: number[] = [];
  for (let c = 0; c < 3; c++) {
    for (let k = 0; k < perCluster; k++) {
      X.push(centers[c].map((m) => m + gauss() * 0.6));
      labels.push(c);
    }
  }
  return { X, labels };
}

function meanIntraInter(Y: number[][], labels: number[]): { intra: number; inter: number } {
  const dist = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));
  let intraSum = 0, intraN = 0, interSum = 0, interN = 0;
  for (let i = 0; i < Y.length; i++) {
    for (let j = i + 1; j < Y.length; j++) {
      const d = dist(Y[i], Y[j]);
      if (labels[i] === labels[j]) { intraSum += d; intraN++; } else { interSum += d; interN++; }
    }
  }
  return { intra: intraSum / intraN, inter: interSum / interN };
}

// FIXTURE: three separated high-dim clusters must separate in 3D (numeric test).
test("t-SNE separates three well-separated clusters in 3D", () => {
  const { X, labels } = threeClusters();
  const Y = tsne(X, { seed: 7, iterations: 500, dims: 3 });
  assert.equal(Y.length, X.length);
  assert.equal(Y[0].length, 3);
  const { intra, inter } = meanIntraInter(Y, labels);
  // Inter-cluster distance should be clearly larger than intra-cluster: three
  // well-separated high-dim clusters must remain three separated blobs in 3D.
  assert.ok(inter > intra * 1.8, `inter ${inter.toFixed(2)} should clearly exceed intra ${intra.toFixed(2)}`);
});

// FIXTURE: same seed + same input = identical output (deterministic).
test("t-SNE is reproducible for a fixed seed", () => {
  const { X } = threeClusters(6, 6);
  const a = tsne(X, { seed: 42, iterations: 120 });
  const b = tsne(X, { seed: 42, iterations: 120 });
  assert.deepEqual(a, b);
});

// FIXTURE: IDF down-weighting suppresses ubiquitous concepts.
test("IDF: rarer shared concepts weigh more than ubiquitous ones", () => {
  const n = 100;
  assert.ok(idf(1, n) > idf(50, n));
  assert.ok(idf(50, n) > idf(99, n));
  // A concept in (almost) every paper contributes essentially nothing.
  assert.ok(idf(n, n) < 0.05);
});

// FIXTURE: the domain-distance factor rewards distant communities.
test("domain-distance factor is higher for less-similar communities", () => {
  assert.ok(domainDistanceFactor(0.1) > domainDistanceFactor(0.9));
  assert.ok(domainDistanceFactor(0.9) >= 1); // never suppresses
  assert.equal(domainDistanceFactor(1), 1); // identical communities: no boost
});
