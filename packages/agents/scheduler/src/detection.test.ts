import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvalRequiredFor,
  detectStaleStates,
  estimateTaskCost,
  type CorpusSnapshot,
  type LibrarySnapshot,
} from "./detection";

// Fixed clock: detection never reads Date.now(), the snapshot carries `now`.
const NOW = new Date("2026-08-18T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function lib(partial: Partial<LibrarySnapshot> & { id: string; name: string }): LibrarySnapshot {
  return {
    isAllPapers: false,
    paperCount: 20,
    latestSynthesisAt: null,
    lastSynthesisHadError: false,
    papersAddedSinceSynthesis: 0,
    papersWithKeyTerms: 20,
    metricRowCount: 0,
    ...partial,
  };
}

// The spec fixture: three libraries. One with an old synthesis (and new papers
// since), one missing metrics, one complete.
function fixture(): CorpusSnapshot {
  return {
    now: NOW,
    libraries: [
      lib({
        id: "lib-a",
        name: "old-synthesis",
        latestSynthesisAt: daysAgo(45),
        papersAddedSinceSynthesis: 3,
        metricRowCount: 120, // metrics exist, only the synthesis is stale
      }),
      lib({
        id: "lib-b",
        name: "missing-metrics",
        latestSynthesisAt: daysAgo(5),
        metricRowCount: 0,
      }),
      lib({
        id: "lib-c",
        name: "complete",
        latestSynthesisAt: daysAgo(5),
        metricRowCount: 200,
      }),
    ],
    latestCrossDomain: {
      completedAt: daysAgo(10),
      scopeLibraryIds: ["lib-a", "lib-b", "lib-c"],
      linkCount: 6,
      allLinksRejected: false,
    },
    recentAgentFailures: [],
  };
}

test("fixture: identifies stale synthesis and missing metrics, leaves the complete library alone", () => {
  const r = detectStaleStates(fixture(), 30);
  assert.equal(r.tasks.length, 2);
  const kinds = r.tasks.map((t) => t.kind).sort();
  assert.deepEqual(kinds, ["extract_metrics", "re_synthesize"]);
  const resynth = r.tasks.find((t) => t.kind === "re_synthesize")!;
  assert.deepEqual(resynth.scope, ["lib-a"]);
  const metrics = r.tasks.find((t) => t.kind === "extract_metrics")!;
  assert.deepEqual(metrics.scope, ["lib-b"]);
  // The complete library appears in no task scope.
  assert.ok(!r.tasks.some((t) => t.scope.includes("lib-c")));
  assert.equal(r.stats.totalLibraries, 3);
  assert.equal(r.stats.synthesisStale, 1);
  assert.equal(r.stats.metricsMissing, 1);
  assert.equal(r.stats.crossDomainMissing, 0);
  assert.equal(r.stats.proposalsMissing, 0);
  // One diagnostic per finding.
  assert.deepEqual(r.diagnostics.map((d) => d.kind).sort(), ["missing_metrics", "stale_synthesis"]);
});

test("priority sorting: missing metrics (6) outranks stale synthesis (5)", () => {
  const r = detectStaleStates(fixture(), 30);
  assert.equal(r.tasks[0].kind, "extract_metrics");
  assert.equal(r.tasks[0].priority, 6);
  assert.equal(r.tasks[1].kind, "re_synthesize");
  assert.equal(r.tasks[1].priority, 5);
});

test("cost estimation: ~$2 per synthesis, ~$0.30 per metrics library, $5 cap on metrics", () => {
  assert.equal(estimateTaskCost("re_synthesize", 1).usd, 2.0);
  assert.equal(estimateTaskCost("extract_metrics", 1).usd, 0.3);
  assert.equal(estimateTaskCost("extract_metrics", 3).usd, 0.9);
  // Conservative cap: 20 libraries would be $6 uncapped; the spec caps at $5.
  assert.equal(estimateTaskCost("extract_metrics", 20).usd, 5);
  assert.equal(estimateTaskCost("propose_crossovers", 1).usd, 1.0);
  // Token estimates scale with units and are positive.
  assert.ok(estimateTaskCost("re_synthesize", 1).tokens > 0);
  assert.equal(estimateTaskCost("extract_metrics", 3).tokens, 3 * estimateTaskCost("extract_metrics", 1).tokens);
});

test("approval: extract_metrics is auto-approved, consequential kinds are not", () => {
  assert.equal(approvalRequiredFor("extract_metrics"), false);
  assert.equal(approvalRequiredFor("re_synthesize"), true);
  assert.equal(approvalRequiredFor("extract_cross_domain"), true);
  assert.equal(approvalRequiredFor("propose_crossovers"), true);
  const r = detectStaleStates(fixture(), 30);
  for (const t of r.tasks) {
    assert.equal(t.approvalRequired, approvalRequiredFor(t.kind));
  }
});

test("never-synthesized library with papers queues re_synthesize (documented deviation)", () => {
  const snap = fixture();
  snap.libraries.push(lib({ id: "lib-d", name: "never-synthesized", latestSynthesisAt: null, metricRowCount: 50 }));
  const r = detectStaleStates(snap, 30);
  const t = r.tasks.filter((x) => x.kind === "re_synthesize" && x.scope.includes("lib-d"));
  assert.equal(t.length, 1);
  assert.match(t[0].reason, /never synthesized/);
});

test("missing metrics does not require synthesis (documented deviation)", () => {
  const snap = fixture();
  snap.libraries.push(
    lib({ id: "lib-e", name: "no-synth-no-metrics", latestSynthesisAt: null, metricRowCount: 0, papersWithKeyTerms: 12 }),
  );
  const r = detectStaleStates(snap, 30);
  assert.ok(r.tasks.some((t) => t.kind === "extract_metrics" && t.scope.includes("lib-e")));
});

test("stale synthesis with no new papers and no error is NOT queued", () => {
  const snap = fixture();
  snap.libraries = [
    lib({ id: "lib-f", name: "old-but-unchanged", latestSynthesisAt: daysAgo(90), papersAddedSinceSynthesis: 0, metricRowCount: 10 }),
  ];
  snap.latestCrossDomain = null;
  const r = detectStaleStates(snap, 30);
  assert.ok(!r.tasks.some((t) => t.kind === "re_synthesize"));
});

test("cross-domain: uncovered or aged runs queue one corpus-level task", () => {
  // Aged run.
  const snap = fixture();
  snap.latestCrossDomain = { completedAt: daysAgo(40), scopeLibraryIds: ["lib-a", "lib-b", "lib-c"], linkCount: 6, allLinksRejected: false };
  const r1 = detectStaleStates(snap, 30);
  const cd1 = r1.tasks.filter((t) => t.kind === "extract_cross_domain");
  assert.equal(cd1.length, 1);
  assert.equal(cd1[0].scope.length, 3); // all synthesized libraries, one task
  // No run ever.
  const snap2 = fixture();
  snap2.latestCrossDomain = null;
  const r2 = detectStaleStates(snap2, 30);
  assert.equal(r2.tasks.filter((t) => t.kind === "extract_cross_domain").length, 1);
  assert.equal(r2.stats.crossDomainMissing, 1);
});

test("proposals: zero links or all-rejected on the latest run queues propose_crossovers at priority 8", () => {
  const snap = fixture();
  snap.latestCrossDomain = { completedAt: daysAgo(2), scopeLibraryIds: ["lib-a", "lib-b", "lib-c"], linkCount: 0, allLinksRejected: false };
  const r = detectStaleStates(snap, 30);
  const p = r.tasks.filter((t) => t.kind === "propose_crossovers");
  assert.equal(p.length, 1);
  assert.equal(p[0].priority, 8);
  // Priority 8 sorts first.
  assert.equal(r.tasks[0].kind, "propose_crossovers");
});

test("api failures become diagnostics, never retry tasks", () => {
  const snap = fixture();
  snap.recentAgentFailures = [{ agent: "synthesis", libraryId: "lib-a", at: daysAgo(0.5), error: "401 authentication_error" }];
  const r = detectStaleStates(snap, 30);
  const d = r.diagnostics.filter((x) => x.kind === "api_failure");
  assert.equal(d.length, 1);
  assert.equal(r.stats.apiFailures24h, 1);
  // Same task count as the base fixture: no retry was queued.
  assert.equal(r.tasks.length, detectStaleStates(fixture(), 30).tasks.length);
});

test("determinism: identical snapshots produce identical results", () => {
  const a = detectStaleStates(fixture(), 30);
  const b = detectStaleStates(fixture(), 30);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test("the all-papers library and empty libraries are ignored", () => {
  const snap = fixture();
  snap.libraries.push(lib({ id: "lib-g", name: "general", isAllPapers: true, latestSynthesisAt: null }));
  snap.libraries.push(lib({ id: "lib-h", name: "empty", paperCount: 0, latestSynthesisAt: null }));
  const r = detectStaleStates(snap, 30);
  assert.ok(!r.tasks.some((t) => t.scope.includes("lib-g") || t.scope.includes("lib-h")));
  assert.equal(r.stats.totalLibraries, 3);
});
