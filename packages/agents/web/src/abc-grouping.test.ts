import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateSignature, groupAbcCandidates, type AbcCandidateLike } from "./abc-grouping";

// The real fragmentation pattern: one B-bridge (plane wave + lorentz boost)
// between communities 2 and 4, shared evidence papers, fanned out over five
// concept pairings with identical scores.
const SHARED_EVIDENCE = [
  {
    b_label: "plane wave",
    a_leg_papers: [
      { id: "p-fire", title: "Learning Class-Specific Spectral Patterns" },
      { id: "p-planck", title: "Planck 2018 results VI" },
    ],
    c_leg_papers: [{ id: "p-wave", title: "Wave packets in QFT" }],
  },
  {
    b_label: "lorentz boost",
    a_leg_papers: [
      { id: "p-planck", title: "Planck 2018 results VI" },
      { id: "p-cosmicweb", title: "Beta-cosmic-web weighted correlations" },
    ],
    c_leg_papers: [{ id: "p-wave", title: "Wave packets in QFT" }],
  },
];

function meshCandidate(cLabel: string, score = 2.011): AbcCandidateLike {
  return {
    score,
    payload: {
      a_label: "mesh",
      c_label: cLabel,
      a_community: 2,
      c_community: 4,
      domain_distance_factor: 1.31,
      base_score: score / 1.31,
      path_evidence: SHARED_EVIDENCE,
    },
  };
}

function fixture(): AbcCandidateLike[] {
  return [
    // Five fragments of ONE finding (the real pattern from run 8412b5ce).
    meshCandidate("decay rate"),
    meshCandidate("quantum field theory qft"),
    meshCandidate("momentum eigenstate"),
    meshCandidate("time dilation"),
    meshCandidate("special relativity"),
    // Two genuinely distinct findings.
    {
      score: 2.076,
      payload: {
        a_label: "foundation model",
        c_label: "implicit bias",
        a_community: 1,
        c_community: 2,
        domain_distance_factor: 1.2,
        path_evidence: [
          {
            b_label: "pretraining",
            a_leg_papers: [{ id: "p-survey", title: "Questioning the Survey Responses of LLMs" }],
            c_leg_papers: [{ id: "p-geo", title: "Geospatial Foundation Models" }],
          },
        ],
      },
    },
    {
      score: 1.5,
      payload: {
        a_label: "point cloud",
        c_label: "halo finding",
        a_community: 3,
        c_community: 4,
        domain_distance_factor: 1.28,
        path_evidence: [
          {
            b_label: "clustering",
            a_leg_papers: [{ id: "p-pointnet", title: "PointNet" }],
            c_leg_papers: [{ id: "p-fof", title: "Friends of friends halo finding" }],
          },
        ],
      },
    },
  ];
}

test("the real fragmentation collapses: seven candidates become three findings, five nested under one", () => {
  const groups = groupAbcCandidates(fixture());
  assert.equal(groups.length, 3);
  const mesh = groups.find((g) => g.communityPair[0] === 2 && g.communityPair[1] === 4)!;
  assert.ok(mesh);
  assert.equal(mesh.pairings.length, 5);
  assert.deepEqual(mesh.bridgeConcepts, ["lorentz boost", "plane wave"]);
  assert.equal(mesh.evidence.distinctPaperCount, 4); // fire, planck, cosmicweb, wave
  assert.equal(mesh.evidence.aPapers.length, 3);
  assert.equal(mesh.evidence.cPapers.length, 1);
  // Nothing discarded: every pairing keeps its provenance index.
  assert.deepEqual([...mesh.pairings.map((p) => p.sourceIndex)].sort(), [0, 1, 2, 3, 4]);
});

test("differing bridge concepts do NOT collapse, even with the same communities and papers", () => {
  const a = meshCandidate("decay rate");
  const b = meshCandidate("time dilation");
  b.payload.path_evidence = [{ ...SHARED_EVIDENCE[0], b_label: "renormalization" }];
  const groups = groupAbcCandidates([a, b]);
  assert.equal(groups.length, 2);
  assert.notEqual(candidateSignature(a), candidateSignature(b));
});

test("differing evidence papers do NOT collapse", () => {
  const a = meshCandidate("decay rate");
  const b = meshCandidate("time dilation");
  b.payload.path_evidence = [
    { ...SHARED_EVIDENCE[0], a_leg_papers: [{ id: "p-other", title: "A different paper" }] },
    SHARED_EVIDENCE[1],
  ];
  assert.equal(groupAbcCandidates([a, b]).length, 2);
});

test("the community pair is unordered: swapped a/c communities still collapse", () => {
  const a = meshCandidate("decay rate");
  const b = meshCandidate("time dilation");
  b.payload.a_community = 4;
  b.payload.c_community = 2;
  const groups = groupAbcCandidates([a, b]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].communityPair, [2, 4]);
});

test("groups sort by best score desc, pairings by score desc, deterministically", () => {
  const input = fixture();
  const g1 = groupAbcCandidates(input);
  const g2 = groupAbcCandidates(input);
  assert.deepEqual(JSON.parse(JSON.stringify(g1)), JSON.parse(JSON.stringify(g2)));
  assert.equal(g1[0].bestScore, 2.076); // foundation model finding leads
  assert.equal(g1[1].pairings.length, 5);
  for (let i = 1; i < g1.length; i++) assert.ok(g1[i - 1].bestScore >= g1[i].bestScore);
});
