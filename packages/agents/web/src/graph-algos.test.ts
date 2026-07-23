import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adjustedRandIndex,
  computeBetweenness,
  cosineSim,
  louvainPartition,
  mergeTermsByEmbedding,
  normalizeTerm,
  projectionWeight,
  scoreABC,
  type WeightedEdge,
} from "./graph-algos";

// FIXTURE 1: concept canonicalization, a must-merge pair and a must-NOT-merge pair.
test("concept canonicalization: string normalization merges and separates correctly", () => {
  // must-merge (string level): hyphen/space + plural fold.
  assert.equal(normalizeTerm("Graph Neural Networks"), "graph neural network");
  assert.equal(normalizeTerm("graph-neural-network"), "graph neural network");
  assert.equal(normalizeTerm("Point Clouds"), "point cloud");
  // must-NOT-merge: genuinely different concepts stay distinct.
  assert.notEqual(normalizeTerm("semantic segmentation"), normalizeTerm("instance segmentation"));
  assert.notEqual(normalizeTerm("3D reconstruction"), normalizeTerm("3D representation"));
  // "analysis" must not be mangled into "analysi".
  assert.equal(normalizeTerm("analysis"), "analysis");
});

// FIXTURE 2: embedding merge under the high threshold (under-merge bias).
test("embedding merge: near-duplicates merge, distinct concept stays separate", () => {
  // Three unit-ish vectors: v0 and v1 are ~parallel (cos ~0.999), v2 is orthogonal.
  const v0 = [1, 0, 0];
  const v1 = [0.98, 0.02, 0];
  const v2 = [0, 1, 0];
  assert.ok(cosineSim(v0, v1) >= 0.9);
  assert.ok(cosineSim(v0, v2) < 0.9);
  const groups = mergeTermsByEmbedding([v0, v1, v2], 0.9);
  // Expect two groups: {0,1} and {2}.
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], [0, 1]);
  assert.deepEqual(groups[1], [2]);
});

// FIXTURE 3: ABC scorer with the ubiquitous-B degree penalty.
test("ABC scorer: a specific-B candidate outscores a ubiquitous-B-only candidate", () => {
  // Candidate 1: connected ONLY through one ubiquitous B (huge degree), many paths.
  const ubiquitous = scoreABC([{ sAB: 5, sBC: 5, degreeB: 1000 }]);
  // Candidate 2: connected through three specific, low-degree Bs.
  const specific = scoreABC([
    { sAB: 2, sBC: 2, degreeB: 6 },
    { sAB: 2, sBC: 2, degreeB: 6 },
    { sAB: 2, sBC: 2, degreeB: 6 },
  ]);
  assert.ok(specific > ubiquitous, `specific ${specific} should beat ubiquitous ${ubiquitous}`);
  // Support cap: 100 paths cannot inflate beyond cap=5.
  const capped = scoreABC([{ sAB: 100, sBC: 100, degreeB: 6 }]);
  const atCap = scoreABC([{ sAB: 5, sBC: 5, degreeB: 6 }]);
  assert.equal(capped, atCap);
});

// FIXTURE 4: projection weight combines the signal vector deterministically.
test("projection weight is a deterministic weighted sum", () => {
  const w = { semantic: 1.0, concept: 0.3, method: 0.6, dataset: 0.4, claims: 0.8, cite: 0.7 };
  const s = { semantic: 0.6, sharedConcepts: 2, sharedMethods: 1, sharedDatasets: 0, claimLinks: 1, citations: 0 };
  // 0.6 + 2*0.3 + 1*0.6 + 0 + 1*0.8 + 0 = 0.6+0.6+0.6+0.8 = 2.6
  assert.ok(Math.abs(projectionWeight(s, w) - 2.6) < 1e-9);
});

// FIXTURE 5: seeded Louvain is reproducible and separates two clear clusters.
test("seeded Louvain: same seed = same partition, and two clusters separate", () => {
  // Two triangles (A,B,C) and (D,E,F) joined by one weak bridge edge C-D.
  const nodes = ["A", "B", "C", "D", "E", "F"];
  const edges: WeightedEdge[] = [
    { a: "A", b: "B", weight: 5 },
    { a: "B", b: "C", weight: 5 },
    { a: "A", b: "C", weight: 5 },
    { a: "D", b: "E", weight: 5 },
    { a: "E", b: "F", weight: 5 },
    { a: "D", b: "F", weight: 5 },
    { a: "C", b: "D", weight: 0.1 },
  ];
  const p1 = louvainPartition(nodes, edges, 1.0, 42);
  const p2 = louvainPartition(nodes, edges, 1.0, 42);
  assert.deepEqual(p1, p2); // reproducible
  // A,B,C share a community distinct from D,E,F.
  assert.equal(p1["A"], p1["B"]);
  assert.equal(p1["A"], p1["C"]);
  assert.equal(p1["D"], p1["E"]);
  assert.equal(p1["D"], p1["F"]);
  assert.notEqual(p1["A"], p1["D"]);
});

// FIXTURE 6: betweenness on a barbell graph, the bridge node has max betweenness.
test("betweenness: the bridge node of a barbell graph is the maximum", () => {
  // Two triangles joined through a single middle node M: (A,B,C)-M-(D,E,F).
  const nodes = ["A", "B", "C", "M", "D", "E", "F"];
  const edges: WeightedEdge[] = [
    { a: "A", b: "B", weight: 1 },
    { a: "B", b: "C", weight: 1 },
    { a: "A", b: "C", weight: 1 },
    { a: "C", b: "M", weight: 1 },
    { a: "M", b: "D", weight: 1 },
    { a: "D", b: "E", weight: 1 },
    { a: "E", b: "F", weight: 1 },
    { a: "D", b: "F", weight: 1 },
  ];
  const bc = computeBetweenness(nodes, edges);
  const maxNode = Object.entries(bc).sort((x, y) => y[1] - x[1])[0][0];
  assert.equal(maxNode, "M");
});

// FIXTURE 7: ARI is 1 for identical partitions and lower for a split.
test("adjusted Rand index: identical = 1, a merge/split is < 1", () => {
  assert.equal(adjustedRandIndex([0, 0, 1, 1], [0, 0, 1, 1]), 1);
  assert.equal(adjustedRandIndex([0, 0, 1, 1], [5, 5, 9, 9]), 1); // label-invariant
  // One item moved across the partition boundary lowers ARI below 1.
  assert.ok(adjustedRandIndex([0, 0, 1, 1], [0, 1, 1, 1]) < 1);
});
