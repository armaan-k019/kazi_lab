import { test } from "node:test";
import assert from "node:assert/strict";
import { computePools, poolSlice, type MetricRow } from "./pooling";

// Build a metric row with sensible defaults for the fixtures.
function row(p: Partial<MetricRow> & { paperLabel: string; methodName: string; value: number }): MetricRow {
  return {
    paperId: p.paperLabel,
    paperLabel: p.paperLabel,
    methodName: p.methodName,
    isSelf: p.isSelf ?? false,
    value: p.value,
    datasetCanon: p.datasetCanon ?? "ModelNet40",
    metricCanon: p.metricCanon ?? "accuracy",
    taskCanon: p.taskCanon ?? "classification",
    conditions: p.conditions ?? "(default)",
    dispersion: p.dispersion ?? null,
  };
}

// FIXTURE 1: two papers report A/B/C on the same key/conditions with identical
// per-method values across papers (no conflict), so rank and vote-count are
// exactly determined.
//   P1: A=90, B=88, C=85    P2: A=90, B=88
test("rank aggregation and win-rates on a known fixture", () => {
  const rows = [
    row({ paperLabel: "P1", methodName: "A", value: 90 }),
    row({ paperLabel: "P1", methodName: "B", value: 88 }),
    row({ paperLabel: "P1", methodName: "C", value: 85 }),
    row({ paperLabel: "P2", methodName: "A", value: 90 }),
    row({ paperLabel: "P2", methodName: "B", value: 88 }),
  ];
  const s = poolSlice(rows);
  assert.equal(s.nMethods, 3);
  assert.equal(s.nPapers, 2);

  // Ranks: A best in both (1,1), B second (2,2), C third once (3).
  const rank = (m: string) => s.ranks.find((r) => r.method === m)!;
  assert.equal(rank("A").meanRank, 1);
  assert.equal(rank("A").nPapers, 2);
  assert.equal(rank("B").meanRank, 2);
  assert.equal(rank("C").meanRank, 3);
  assert.equal(rank("C").nPapers, 1);

  // Win-rates. P1 pairs: A>B, A>C, B>C. P2 pairs: A>B.
  // A: wins {A>B x2, A>C} = 3, losses 0 -> 1.0
  // B: wins {B>C} = 1, losses {A>B x2} = 2 -> 1/3
  // C: wins 0, losses {A>C, B>C} = 2 -> 0
  const win = (m: string) => s.winRates.find((w) => w.method === m)!;
  assert.equal(win("A").wins, 3);
  assert.equal(win("A").losses, 0);
  assert.equal(win("A").winRate, 1);
  assert.equal(win("B").wins, 1);
  assert.equal(win("B").losses, 2);
  assert.ok(Math.abs(win("B").winRate - 1 / 3) < 1e-9);
  assert.equal(win("C").winRate, 0);

  // best/median pool, no self reports: each method's single value.
  const pool = (m: string) => s.methods.find((x) => x.method === m)!;
  assert.equal(pool("A").pooledValue, 90);
  assert.equal(pool("A").conflict, false);
  assert.equal(pool("A").pooledFromSelf, false);
});

// FIXTURE 2: self-report preference and conflict flagging. Method D is reported
// as 93 by its own paper (self) and re-reported as 92 elsewhere: values differ
// beyond tolerance, so it is a flagged conflict, and the SELF value wins.
test("self-report preference and conflict flag", () => {
  const rows = [
    row({ paperLabel: "Dpaper", methodName: "D", value: 93, isSelf: true }),
    row({ paperLabel: "Other", methodName: "D", value: 92, isSelf: false }),
  ];
  const s = poolSlice(rows);
  const d = s.methods.find((x) => x.method === "D")!;
  assert.equal(d.conflict, true);
  assert.equal(d.pooledFromSelf, true);
  assert.equal(d.pooledValue, 93); // self wins, not the median 92.5
  assert.equal(s.conflicts.length, 1);
  assert.deepEqual(s.conflicts[0].values, [92, 93]);
});

// FIXTURE 3: the conditions discipline. The same key with two different
// conditions must produce two separate slices, never merged.
test("conditions slices never merge", () => {
  const rows = [
    row({ paperLabel: "P1", methodName: "A", value: 70, metricCanon: "mIoU", datasetCanon: "S3DIS", taskCanon: "semantic segmentation", conditions: "Area 5" }),
    row({ paperLabel: "P2", methodName: "A", value: 73, metricCanon: "mIoU", datasetCanon: "S3DIS", taskCanon: "semantic segmentation", conditions: "Area 5" }),
    row({ paperLabel: "P1", methodName: "A", value: 65, metricCanon: "mIoU", datasetCanon: "S3DIS", taskCanon: "semantic segmentation", conditions: "6-fold" }),
    row({ paperLabel: "P2", methodName: "A", value: 68, metricCanon: "mIoU", datasetCanon: "S3DIS", taskCanon: "semantic segmentation", conditions: "6-fold" }),
  ];
  const { slices } = computePools(rows);
  assert.equal(slices.length, 2);
  const conds = slices.map((s) => s.conditions).sort();
  assert.deepEqual(conds, ["6-fold", "Area 5"]);
});

// FIXTURE 4: single-paper slices are dropped from the cross-paper meta-analysis
// and counted, never silently hidden.
test("single-paper slices are dropped and counted", () => {
  const rows = [
    // A genuine 2-paper slice (kept).
    row({ paperLabel: "P1", methodName: "A", value: 90 }),
    row({ paperLabel: "P2", methodName: "A", value: 90 }),
    // A single-paper slice on a different key (dropped, counted).
    row({ paperLabel: "Solo", methodName: "X", value: 50, datasetCanon: "OnlyOne" }),
  ];
  const { slices, droppedSinglePaper } = computePools(rows);
  assert.equal(slices.length, 1);
  assert.equal(droppedSinglePaper, 1);
});

// FIXTURE 5: lower-is-better metric inverts ranking and win direction.
test("lower-is-better metric inverts ranking", () => {
  const rows = [
    row({ paperLabel: "P1", methodName: "Fast", value: 5, metricCanon: "latency" }),
    row({ paperLabel: "P1", methodName: "Slow", value: 20, metricCanon: "latency" }),
    row({ paperLabel: "P2", methodName: "Fast", value: 5, metricCanon: "latency" }),
    row({ paperLabel: "P2", methodName: "Slow", value: 20, metricCanon: "latency" }),
  ];
  const s = poolSlice(rows);
  assert.equal(s.higherIsBetter, false);
  assert.equal(s.ranks.find((r) => r.method === "Fast")!.meanRank, 1);
  assert.equal(s.winRates.find((w) => w.method === "Fast")!.winRate, 1);
});

// FIXTURE 6: variance-weighted subset only fires with >=3 dispersion rows, and
// weights lower-variance results more.
test("variance-weighted subset requires >=3 dispersion rows", () => {
  const two = poolSlice([
    row({ paperLabel: "P1", methodName: "A", value: 90, dispersion: "0.5" }),
    row({ paperLabel: "P2", methodName: "B", value: 80, dispersion: "0.5" }),
  ]);
  assert.equal(two.varianceSubset, null);

  const three = poolSlice([
    row({ paperLabel: "P1", methodName: "A", value: 90, dispersion: "0.1" }),
    row({ paperLabel: "P2", methodName: "B", value: 80, dispersion: "1.0" }),
    row({ paperLabel: "P3", methodName: "C", value: 82, dispersion: "1.0" }),
  ]);
  assert.ok(three.varianceSubset);
  // Tight-variance A (std 0.1) dominates, pulling the mean close to 90.
  assert.ok(three.varianceSubset!.weightedMean > 89);
});
