import Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import {
  db,
  MODELS,
  webBridges,
  webBuildRuns,
  webCommunities,
  webEdges,
  webNodes,
} from "@kazi-lab/db";
import { extractJsonObject } from "@kazi-lab/lab";
import { embedTexts } from "@kazi-lab/scribe";
import {
  adjustedRandIndex,
  computeBetweenness,
  louvainPartition,
  mergeTermsByEmbedding,
  normalizeTerm,
  projectionWeight,
  scoreABC,
  type BContribution,
  type PairSignals,
  type WeightVector,
  type WeightedEdge,
} from "./graph-algos";

const MODEL = MODELS.judgment;

// Documented build defaults. semantic_floor is deliberately above the RAG floor
// (0.45) so a graph edge means more than mere retrievability. concept merge
// threshold is deliberately high (under-merge over over-merge). The projection
// weight vector is the emergent-domain tuning surface.
export const DEFAULT_PARAMS = {
  knnK: 8,
  semanticFloor: 0.55,
  louvainResolution: 1.0,
  seed: 1337,
  conceptMergeThreshold: 0.9,
  weights: { semantic: 1.0, concept: 0.3, method: 0.6, dataset: 0.4, claims: 0.8, cite: 0.7 } as WeightVector,
  topNbridges: 12,
  topNabc: 20,
  // Compute bound: an intermediate B that co-occurs with more than this many
  // other attribute nodes does not seed ABC pairs (it would be a truism anyway;
  // the degree penalty already suppresses it). Documented, not silent.
  abcBNeighborCap: 60,
};
export type WebParams = typeof DEFAULT_PARAMS;

// FUTURE ENRICHMENT: methods named only in prose (not paper_metrics) and
// citation crawling are out of scope for v1; methods come from paper_metrics
// only, and cites use the existing citations table as-is.

export type WebBuildResult =
  | { status: "empty"; reason: string }
  | { status: "completed"; runId: string; stats: Record<string, unknown> }
  | { status: "failed"; runId: string; error: string };

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}

// A stable string key per node so edges can reference nodes before ids exist.
const paperKey = (id: string) => `paper:${id}`;
const claimKey = (id: string) => `claim:${id}`;
const conceptKey = (canon: string) => `concept:${canon}`;
const methodKey = (canon: string) => `method:${canon}`;
const datasetKey = (canon: string) => `dataset:${canon}`;
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

type NodeSpec = {
  key: string;
  kind: "paper" | "claim" | "method" | "concept" | "dataset";
  refTable: string | null;
  refId: string | null;
  mergedFrom: string[] | null;
  label: string;
  canonicalLabel: string;
};
type EdgeSpec = {
  srcKey: string;
  dstKey: string;
  kind: string;
  weight: number;
  provenance: Record<string, unknown>;
};

// Build the corpus-wide research web as an immutable run. Deterministic graph
// construction + community detection + bridges + ABC; a single LLM call labels
// communities (labeling only, no links). Transactional.
export async function buildWeb(paramsIn?: Partial<WebParams>): Promise<WebBuildResult> {
  const params: WebParams = { ...DEFAULT_PARAMS, ...paramsIn };
  const w = params.weights;

  // ---------------------------------------------------------------------
  // LOAD CORPUS (read-only)
  // ---------------------------------------------------------------------
  const papers = (await db.execute<{ id: string; title: string }>(
    sql`select id, title from papers`,
  )).rows;
  if (papers.length < 2) {
    return { status: "empty", reason: "The corpus has fewer than two papers; nothing to weave." };
  }
  const paperIds = papers.map((p) => p.id);
  const titleByPaper = new Map(papers.map((p) => [p.id, p.title]));

  const claims = (await db.execute<{ id: string; paper_id: string; text: string }>(
    sql`select id, paper_id, text from claims`,
  )).rows;
  const paperByClaim = new Map(claims.map((c) => [c.id, c.paper_id]));

  const relations = (await db.execute<{ id: string; from_claim_id: string; to_claim_id: string; relation_type: string }>(sql`
    select distinct on (from_claim_id, to_claim_id, relation_type)
      id, from_claim_id, to_claim_id, relation_type
    from claim_relations`)).rows;

  const extractionRows = (await db.execute<{ paper_id: string; key_terms: string[] }>(
    sql`select paper_id, key_terms from extractions where key_terms is not null`,
  )).rows;

  const metricRows = (await db.execute<{ paper_id: string; method_name: string | null; dataset_canon: string | null }>(sql`
    select distinct paper_id, method_name, dataset_canon from paper_metrics`)).rows;

  const citationRows = (await db.execute<{ citing_paper_id: string; cited_paper_id: string }>(sql`
    select citing_paper_id, cited_paper_id from citations where cited_paper_id is not null`)).rows;

  const libRows = (await db.execute<{ paper_id: string; library_id: string; name: string; added_at: string }>(sql`
    select pl.paper_id, pl.library_id, l.name, pl.added_at
    from paper_libraries pl join libraries l on l.id = pl.library_id
    order by pl.added_at asc`)).rows;

  // Paper-level embeddings kNN over pgvector. Keep neighbors at or above the
  // semantic floor; weight = cosine similarity (1 - cosine distance).
  const knn = (await db.execute<{ paper_id: string; neighbor_paper_id: string; similarity: number }>(sql`
    select e.paper_id, n.paper_id as neighbor_paper_id, 1 - (e.embedding <=> n.embedding) as similarity
    from embeddings e
    cross join lateral (
      select o.paper_id, o.embedding
      from embeddings o
      where o.entity_type = 'paper' and o.paper_id <> e.paper_id
      order by e.embedding <=> o.embedding
      limit ${params.knnK}
    ) n
    where e.entity_type = 'paper'`)).rows;

  // ---------------------------------------------------------------------
  // METHOD + DATASET NODES (canonicalized trivially: trim/case)
  // ---------------------------------------------------------------------
  const methodCanonToLabel = new Map<string, string>(); // canon -> display label
  const paperMethods = new Map<string, Set<string>>(); // paperId -> set of method canons
  const datasetCanonToLabel = new Map<string, string>();
  const paperDatasets = new Map<string, Set<string>>();
  for (const m of metricRows) {
    if (m.method_name && m.method_name.trim()) {
      const canon = m.method_name.trim().toLowerCase();
      if (!methodCanonToLabel.has(canon)) methodCanonToLabel.set(canon, m.method_name.trim());
      const s = paperMethods.get(m.paper_id) ?? new Set();
      s.add(canon);
      paperMethods.set(m.paper_id, s);
    }
    if (m.dataset_canon && m.dataset_canon.trim()) {
      const canon = m.dataset_canon.trim().toLowerCase();
      if (!datasetCanonToLabel.has(canon)) datasetCanonToLabel.set(canon, m.dataset_canon.trim());
      const s = paperDatasets.get(m.paper_id) ?? new Set();
      s.add(canon);
      paperDatasets.set(m.paper_id, s);
    }
  }
  const methodCanonSet = new Set(methodCanonToLabel.keys());
  const datasetNormSet = new Set([...datasetCanonToLabel.keys()].map((d) => normalizeTerm(d)));

  // ---------------------------------------------------------------------
  // CONCEPT NODES via canonicalization: string normalize -> embedding merge
  // ---------------------------------------------------------------------
  // Distinct normalized terms (excluding those that ARE a method or dataset).
  const normTermToRaws = new Map<string, Set<string>>(); // normalized -> raw variants
  const paperRawTerms = new Map<string, string[]>(); // paperId -> raw terms
  for (const e of extractionRows) {
    const raws = paperRawTerms.get(e.paper_id) ?? [];
    for (const raw of e.key_terms ?? []) {
      const t = (raw ?? "").trim();
      if (!t) continue;
      raws.push(t);
      const norm = normalizeTerm(t);
      if (!norm) continue;
      // Concept quality filter: drop single/double-char and purely-numeric
      // normalized terms (e.g. "m", "3d", "2021"). These are key-term extraction
      // artifacts, not concepts, and they pollute ABC discovery. Documented.
      if (norm.length < 3 || /^\d+$/.test(norm)) continue;
      // A term that is exactly a method or dataset becomes a mention of that
      // node, not a duplicate concept.
      if (methodCanonSet.has(t.toLowerCase()) || datasetNormSet.has(norm)) continue;
      const set = normTermToRaws.get(norm) ?? new Set();
      set.add(t);
      normTermToRaws.set(norm, set);
    }
    paperRawTerms.set(e.paper_id, raws);
  }
  const distinctNorms = [...normTermToRaws.keys()];

  // Embedding merge of the distinct normalized terms (batched Voyage call).
  let conceptMerges = 0;
  const normToConceptCanon = new Map<string, string>(); // normalized term -> concept canonical label
  const conceptMergedFrom = new Map<string, Set<string>>(); // concept canon -> raw terms merged
  if (distinctNorms.length > 0) {
    const vectors = await embedTexts(distinctNorms, "document");
    const groups = mergeTermsByEmbedding(vectors, params.conceptMergeThreshold);
    for (const group of groups) {
      // Canonical label = the shortest normalized member (stable, readable).
      const memberNorms = group.map((i) => distinctNorms[i]);
      const canon = [...memberNorms].sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0];
      const mergedRaws = conceptMergedFrom.get(canon) ?? new Set();
      for (const idx of group) {
        const norm = distinctNorms[idx];
        normToConceptCanon.set(norm, canon);
        for (const raw of normTermToRaws.get(norm) ?? []) mergedRaws.add(raw);
      }
      conceptMergedFrom.set(canon, mergedRaws);
      if (group.length > 1) conceptMerges += group.length - 1;
    }
  }
  const conceptCanons = [...new Set([...normToConceptCanon.values()])];

  // Per-paper concept canon set (for co-occurrence + mentions edges).
  const paperConcepts = new Map<string, Set<string>>();
  for (const [paperId, raws] of paperRawTerms) {
    const set = new Set<string>();
    for (const raw of raws) {
      const norm = normalizeTerm(raw);
      const canon = normToConceptCanon.get(norm);
      if (canon) set.add(canon);
    }
    if (set.size) paperConcepts.set(paperId, set);
  }

  // ---------------------------------------------------------------------
  // NODE SPECS
  // ---------------------------------------------------------------------
  const nodes: NodeSpec[] = [];
  for (const p of papers) {
    nodes.push({ key: paperKey(p.id), kind: "paper", refTable: "papers", refId: p.id, mergedFrom: null, label: truncate(p.title, 200), canonicalLabel: truncate(p.title, 200) });
  }
  for (const c of claims) {
    nodes.push({ key: claimKey(c.id), kind: "claim", refTable: "claims", refId: c.id, mergedFrom: null, label: truncate(c.text, 160), canonicalLabel: truncate(c.text, 160) });
  }
  for (const canon of methodCanonToLabel.keys()) {
    nodes.push({ key: methodKey(canon), kind: "method", refTable: "paper_metrics", refId: null, mergedFrom: null, label: methodCanonToLabel.get(canon)!, canonicalLabel: canon });
  }
  for (const canon of datasetCanonToLabel.keys()) {
    nodes.push({ key: datasetKey(canon), kind: "dataset", refTable: "paper_metrics", refId: null, mergedFrom: null, label: datasetCanonToLabel.get(canon)!, canonicalLabel: canon });
  }
  for (const canon of conceptCanons) {
    const merged = [...(conceptMergedFrom.get(canon) ?? [])];
    nodes.push({ key: conceptKey(canon), kind: "concept", refTable: null, refId: null, mergedFrom: merged, label: canon, canonicalLabel: canon });
  }

  // ---------------------------------------------------------------------
  // EDGE SPECS (all weighted, all with provenance)
  // ---------------------------------------------------------------------
  const edges: EdgeSpec[] = [];
  // semantic (undirected; keep the max cosine per pair)
  const semByPair = new Map<string, number>();
  for (const e of knn) {
    if (e.similarity < params.semanticFloor) continue;
    const k = pairKey(e.paper_id, e.neighbor_paper_id);
    semByPair.set(k, Math.max(semByPair.get(k) ?? 0, Number(e.similarity)));
  }
  for (const [k, sim] of semByPair) {
    const [a, b] = k.split("|");
    edges.push({ srcKey: paperKey(a), dstKey: paperKey(b), kind: "semantic", weight: sim, provenance: { similarity: sim } });
  }
  // claim relations (supports | contradicts | extends) between claim nodes
  const claimPairSignals = new Map<string, number>(); // paper-pair -> claim link count
  for (const r of relations) {
    if (!paperByClaim.has(r.from_claim_id) || !paperByClaim.has(r.to_claim_id)) continue;
    edges.push({ srcKey: claimKey(r.from_claim_id), dstKey: claimKey(r.to_claim_id), kind: r.relation_type, weight: 1.0, provenance: { claimRelationId: r.id, relationType: r.relation_type } });
    const pa = paperByClaim.get(r.from_claim_id)!;
    const pb = paperByClaim.get(r.to_claim_id)!;
    if (pa !== pb) claimPairSignals.set(pairKey(pa, pb), (claimPairSignals.get(pairKey(pa, pb)) ?? 0) + 1);
  }
  // mentions_concept (paper-concept)
  for (const [paperId, canons] of paperConcepts) {
    for (const canon of canons) edges.push({ srcKey: paperKey(paperId), dstKey: conceptKey(canon), kind: "mentions_concept", weight: 1.0, provenance: { concept: canon } });
  }
  // uses_method (paper-method), reports_dataset (paper-dataset)
  for (const [paperId, canons] of paperMethods) {
    for (const canon of canons) edges.push({ srcKey: paperKey(paperId), dstKey: methodKey(canon), kind: "uses_method", weight: 1.0, provenance: { method: canon } });
  }
  for (const [paperId, canons] of paperDatasets) {
    for (const canon of canons) edges.push({ srcKey: paperKey(paperId), dstKey: datasetKey(canon), kind: "reports_dataset", weight: 1.0, provenance: { dataset: canon } });
  }
  // cites (paper-paper), both endpoints in corpus
  const inCorpus = new Set(paperIds);
  const citePairs = new Set<string>();
  for (const c of citationRows) {
    if (!inCorpus.has(c.citing_paper_id) || !inCorpus.has(c.cited_paper_id)) continue;
    edges.push({ srcKey: paperKey(c.citing_paper_id), dstKey: paperKey(c.cited_paper_id), kind: "cites", weight: 1.0, provenance: {} });
    citePairs.add(pairKey(c.citing_paper_id, c.cited_paper_id));
  }

  // ---------------------------------------------------------------------
  // PAPER PROJECTION (weighted paper-paper graph)
  // ---------------------------------------------------------------------
  // Accumulate shared-attribute counts per paper pair.
  const signals = new Map<string, PairSignals>();
  const ensure = (k: string): PairSignals => {
    let s = signals.get(k);
    if (!s) {
      s = { semantic: 0, sharedConcepts: 0, sharedMethods: 0, sharedDatasets: 0, claimLinks: 0, citations: 0 };
      signals.set(k, s);
    }
    return s;
  };
  for (const [k, sim] of semByPair) ensure(k).semantic = sim;
  const accumShared = (paperSets: Map<string, Set<string>>, byAttr: (s: PairSignals) => void) => {
    // Invert: attr -> papers, then pairs within each attr.
    const attrPapers = new Map<string, string[]>();
    for (const [paperId, canons] of paperSets) {
      for (const canon of canons) {
        const arr = attrPapers.get(canon) ?? [];
        arr.push(paperId);
        attrPapers.set(canon, arr);
      }
    }
    for (const ps of attrPapers.values()) {
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) byAttr(ensure(pairKey(ps[i], ps[j])));
      }
    }
  };
  accumShared(paperConcepts, (s) => (s.sharedConcepts += 1));
  accumShared(paperMethods, (s) => (s.sharedMethods += 1));
  accumShared(paperDatasets, (s) => (s.sharedDatasets += 1));
  for (const [k, n] of claimPairSignals) ensure(k).claimLinks = n;
  for (const k of citePairs) ensure(k).citations = 1;

  const projEdges: WeightedEdge[] = [];
  for (const [k, s] of signals) {
    const weight = projectionWeight(s, w);
    if (weight <= 0) continue;
    const [a, b] = k.split("|");
    projEdges.push({ a, b, weight });
  }

  // ---------------------------------------------------------------------
  // COMMUNITY DETECTION (seeded Louvain on the projection)
  // ---------------------------------------------------------------------
  const communityByPaper = louvainPartition(paperIds, projEdges, params.louvainResolution, params.seed);
  // Assign attribute nodes the community where the majority of their papers live.
  const majorityCommunity = (paperSet: Set<string>): number | null => {
    const counts = new Map<number, number>();
    for (const p of paperSet) {
      const c = communityByPaper[p];
      if (c === undefined) continue;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    if (counts.size === 0) return null;
    // Ties: the larger community overall (by paper count) wins; deterministic.
    return [...counts.entries()].sort((x, y) => y[1] - x[1] || communitySize(y[0]) - communitySize(x[0]))[0][0];
  };
  const communitySizes = new Map<number, number>();
  for (const c of Object.values(communityByPaper)) communitySizes.set(c, (communitySizes.get(c) ?? 0) + 1);
  const communitySize = (c: number) => communitySizes.get(c) ?? 0;

  const communityByKey = new Map<string, number>();
  for (const p of paperIds) communityByKey.set(paperKey(p), communityByPaper[p]);
  for (const c of claims) {
    const cc = communityByPaper[c.paper_id];
    if (cc !== undefined) communityByKey.set(claimKey(c.id), cc);
  }
  const conceptPaperSet = (canon: string): Set<string> => {
    const set = new Set<string>();
    for (const [pid, canons] of paperConcepts) if (canons.has(canon)) set.add(pid);
    return set;
  };
  for (const canon of conceptCanons) {
    const mc = majorityCommunity(conceptPaperSet(canon));
    if (mc !== null) communityByKey.set(conceptKey(canon), mc);
  }
  for (const canon of methodCanonToLabel.keys()) {
    const set = new Set<string>();
    for (const [pid, canons] of paperMethods) if (canons.has(canon)) set.add(pid);
    const mc = majorityCommunity(set);
    if (mc !== null) communityByKey.set(methodKey(canon), mc);
  }
  for (const canon of datasetCanonToLabel.keys()) {
    const set = new Set<string>();
    for (const [pid, canons] of paperDatasets) if (canons.has(canon)) set.add(pid);
    const mc = majorityCommunity(set);
    if (mc !== null) communityByKey.set(datasetKey(canon), mc);
  }
  const communityIndices = [...new Set(Object.values(communityByPaper))].sort((a, b) => a - b);

  // ---------------------------------------------------------------------
  // NODE DEGREE (full-graph, for storage + ABC penalty basis)
  // ---------------------------------------------------------------------
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.srcKey, (degree.get(e.srcKey) ?? 0) + 1);
    degree.set(e.dstKey, (degree.get(e.dstKey) ?? 0) + 1);
  }
  const projDegree = new Map<string, number>();
  for (const e of projEdges) {
    projDegree.set(e.a, (projDegree.get(e.a) ?? 0) + 1);
    projDegree.set(e.b, (projDegree.get(e.b) ?? 0) + 1);
  }

  // ---------------------------------------------------------------------
  // BRIDGE ANALYTICS (betweenness on the projection)
  // ---------------------------------------------------------------------
  const betweenness = computeBetweenness(paperIds, projEdges);
  // Which communities does each paper connect through its projection neighbors?
  const neighborCommunities = new Map<string, Set<number>>();
  for (const e of projEdges) {
    const ca = communityByPaper[e.a];
    const cb = communityByPaper[e.b];
    if (ca !== undefined && cb !== undefined && ca !== cb) {
      (neighborCommunities.get(e.a) ?? neighborCommunities.set(e.a, new Set()).get(e.a)!).add(cb).add(communityByPaper[e.a]);
      (neighborCommunities.get(e.b) ?? neighborCommunities.set(e.b, new Set()).get(e.b)!).add(ca).add(communityByPaper[e.b]);
    }
  }
  type BridgePayload = Record<string, unknown>;
  const bridges: { kind: "node_bridge" | "edge_bridge" | "abc"; score: number; payload: BridgePayload }[] = [];
  const nodeBridgeCandidates = paperIds
    .filter((p) => (neighborCommunities.get(p)?.size ?? 0) >= 2)
    .map((p) => ({ paperId: p, betweenness: betweenness[p] ?? 0, communities: [...(neighborCommunities.get(p) ?? [])] }))
    .sort((a, b) => b.betweenness - a.betweenness)
    .slice(0, params.topNbridges);
  for (const nb of nodeBridgeCandidates) {
    bridges.push({ kind: "node_bridge", score: nb.betweenness, payload: { paper_id: nb.paperId, title: titleByPaper.get(nb.paperId), betweenness: nb.betweenness, communities: nb.communities } });
  }
  const edgeBridgeCandidates = projEdges
    .filter((e) => communityByPaper[e.a] !== communityByPaper[e.b])
    .map((e) => ({ e, score: e.weight * (1 + (betweenness[e.a] ?? 0) + (betweenness[e.b] ?? 0)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, params.topNbridges);
  for (const eb of edgeBridgeCandidates) {
    bridges.push({ kind: "edge_bridge", score: eb.score, payload: { a_paper: eb.e.a, a_title: titleByPaper.get(eb.e.a), b_paper: eb.e.b, b_title: titleByPaper.get(eb.e.b), weight: eb.e.weight, communities: [communityByPaper[eb.e.a], communityByPaper[eb.e.b]] } });
  }

  // ---------------------------------------------------------------------
  // ABC DISCOVERY (concept level + methods as honorary concepts)
  // ---------------------------------------------------------------------
  // Attribute nodes = concepts + methods. Co-occurrence: attr -> attr -> papers.
  type AttrKey = string;
  const attrPaperSets = new Map<AttrKey, Set<string>>();
  const paperAttrs = new Map<string, AttrKey[]>();
  for (const p of paperIds) {
    const attrs: AttrKey[] = [];
    for (const canon of paperConcepts.get(p) ?? []) attrs.push(conceptKey(canon));
    for (const canon of paperMethods.get(p) ?? []) attrs.push(methodKey(canon));
    paperAttrs.set(p, attrs);
    for (const a of attrs) (attrPaperSets.get(a) ?? attrPaperSets.set(a, new Set()).get(a)!).add(p);
  }
  const cooc = new Map<AttrKey, Map<AttrKey, Set<string>>>(); // A -> B -> shared papers
  for (const p of paperIds) {
    const attrs = paperAttrs.get(p) ?? [];
    for (let i = 0; i < attrs.length; i++) {
      for (let j = i + 1; j < attrs.length; j++) {
        const a = attrs[i];
        const b = attrs[j];
        (cooc.get(a) ?? cooc.set(a, new Map()).get(a)!);
        (cooc.get(b) ?? cooc.set(b, new Map()).get(b)!);
        (cooc.get(a)!.get(b) ?? cooc.get(a)!.set(b, new Set()).get(b)!).add(p);
        (cooc.get(b)!.get(a) ?? cooc.get(b)!.set(a, new Set()).get(a)!).add(p);
      }
    }
  }
  // Enumerate over B: for each pair (A,C) of B's co-occurrence neighbors that are
  // in DIFFERENT communities and DO NOT directly co-occur, accumulate B's leg.
  type ABCAcc = { contributions: BContribution[]; paths: { b: string; aPapers: string[]; cPapers: string[] }[] };
  const abcAcc = new Map<string, ABCAcc>();
  for (const [b, neighborsMap] of cooc) {
    const neighbors = [...neighborsMap.keys()];
    if (neighbors.length > params.abcBNeighborCap) continue; // documented compute bound
    const degB = attrPaperSets.get(b)?.size ?? 0;
    for (let i = 0; i < neighbors.length; i++) {
      for (let j = i + 1; j < neighbors.length; j++) {
        const a = neighbors[i];
        const c = neighbors[j];
        if (communityByKey.get(a) === communityByKey.get(c)) continue; // same domain: not a crossover
        if (communityByKey.get(a) === undefined || communityByKey.get(c) === undefined) continue;
        if (cooc.get(a)?.has(c)) continue; // direct co-occurrence: not an ABC hypothesis
        const aPapers = [...(neighborsMap.get(a) ?? [])];
        const cPapers = [...(neighborsMap.get(c) ?? [])];
        if (!aPapers.length || !cPapers.length) continue;
        const key = pairKey(a, c);
        const acc = abcAcc.get(key) ?? { contributions: [], paths: [] };
        acc.contributions.push({ sAB: aPapers.length, sBC: cPapers.length, degreeB: degB });
        acc.paths.push({ b, aPapers: aPapers.slice(0, 5), cPapers: cPapers.slice(0, 5) });
        abcAcc.set(key, acc);
      }
    }
  }
  const labelOfKey = (k: string): string => {
    const node = nodes.find((n) => n.key === k);
    return node?.label ?? k;
  };
  const abcScored = [...abcAcc.entries()]
    .map(([key, acc]) => {
      const [a, c] = key.split("|");
      return {
        score: scoreABC(acc.contributions),
        payload: {
          a_node: a,
          a_label: labelOfKey(a),
          c_node: c,
          c_label: labelOfKey(c),
          a_community: communityByKey.get(a),
          c_community: communityByKey.get(c),
          path_evidence: acc.paths
            .sort((x, y) => y.aPapers.length + y.cPapers.length - (x.aPapers.length + x.cPapers.length))
            .slice(0, 6)
            .map((pth) => ({
              b_node: pth.b,
              b_label: labelOfKey(pth.b),
              a_leg_papers: pth.aPapers.map((id) => ({ id, title: truncate(titleByPaper.get(id) ?? id, 90) })),
              c_leg_papers: pth.cPapers.map((id) => ({ id, title: truncate(titleByPaper.get(id) ?? id, 90) })),
            })),
        } as BridgePayload,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, params.topNabc);
  for (const abc of abcScored) bridges.push({ kind: "abc", score: abc.score, payload: abc.payload });

  // ---------------------------------------------------------------------
  // COMMUNITY LABELS (one LLM call: labeling only, no links)
  // ---------------------------------------------------------------------
  const communityTop = new Map<number, { concepts: string[]; methods: string[]; titles: string[] }>();
  for (const ci of communityIndices) {
    const cPapers = paperIds.filter((p) => communityByPaper[p] === ci);
    const conceptCount = new Map<string, number>();
    const methodCount = new Map<string, number>();
    for (const p of cPapers) {
      for (const canon of paperConcepts.get(p) ?? []) conceptCount.set(canon, (conceptCount.get(canon) ?? 0) + 1);
      for (const canon of paperMethods.get(p) ?? []) methodCount.set(canon, (methodCount.get(canon) ?? 0) + 1);
    }
    const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]);
    communityTop.set(ci, {
      concepts: top(conceptCount, 10),
      methods: top(methodCount, 8).map((c) => methodCanonToLabel.get(c) ?? c),
      titles: cPapers.slice(0, 5).map((p) => truncate(titleByPaper.get(p) ?? "", 80)),
    });
  }
  const labelByCommunity = new Map<number, string>();
  try {
    const doc = communityIndices
      .map((ci) => {
        const t = communityTop.get(ci)!;
        return `COMMUNITY ${ci} (${communitySize(ci)} papers)\n  top concepts: ${t.concepts.join(", ") || "(none)"}\n  top methods: ${t.methods.join(", ") || "(none)"}\n  sample titles: ${t.titles.join(" | ")}`;
      })
      .join("\n\n");
    const client = new Anthropic();
    const resp = await client.messages
      .stream({
        model: MODEL,
        max_tokens: Math.min(2000 + communityIndices.length * 120, 8000),
        system:
          "You LABEL emergent research communities from their top concepts, methods, and sample paper titles. This is labeling, not analysis: produce a SHORT human-readable domain label (2 to 5 words) per community. Do not merge or split communities, do not invent links. Return ONLY JSON: { \"labels\": [ { \"community_index\": 0, \"label\": \"...\" } ] }.",
        messages: [{ role: "user", content: `Label each community:\n\n${doc}` }],
      })
      .finalMessage();
    const block = resp.content.find((b) => b.type === "text");
    const raw = block && block.type === "text" ? block.text : "";
    const parsed = JSON.parse(extractJsonObject(raw)) as { labels?: { community_index?: number; label?: string }[] };
    for (const l of parsed.labels ?? []) {
      if (typeof l.community_index === "number" && typeof l.label === "string" && communitySizes.has(l.community_index)) {
        labelByCommunity.set(l.community_index, l.label.trim());
      }
    }
  } catch {
    // Non-fatal: labels are cosmetic. Unlabeled communities keep a generic name.
  }

  // ---------------------------------------------------------------------
  // SANITY METRICS: ARI vs libraries + orphan report
  // ---------------------------------------------------------------------
  // Primary library = the first NON-general library by added_at; papers with
  // only "general" are grouped as "general-only" (general is the all-papers
  // catch-all, so using it as primary would make ARI meaningless). Documented.
  const primaryLib = new Map<string, string>();
  for (const r of libRows) {
    if (r.name === "general") continue;
    if (!primaryLib.has(r.paper_id)) primaryLib.set(r.paper_id, r.name);
  }
  const libLabelToInt = new Map<string, number>();
  const libInt = (name: string) => {
    if (!libLabelToInt.has(name)) libLabelToInt.set(name, libLabelToInt.size);
    return libLabelToInt.get(name)!;
  };
  const commLabels: number[] = [];
  const libLabelsAll: number[] = [];
  const commLabelsOnTopic: number[] = [];
  const libLabelsOnTopic: number[] = [];
  for (const p of paperIds) {
    commLabels.push(communityByPaper[p]);
    const lib = primaryLib.get(p) ?? "general-only";
    libLabelsAll.push(libInt(lib));
    if (primaryLib.has(p)) {
      commLabelsOnTopic.push(communityByPaper[p]);
      libLabelsOnTopic.push(libInt(primaryLib.get(p)!));
    }
  }
  const ariAll = adjustedRandIndex(commLabels, libLabelsAll);
  const ariOnTopic = commLabelsOnTopic.length >= 2 ? adjustedRandIndex(commLabelsOnTopic, libLabelsOnTopic) : null;

  const tinyCommunities = communityIndices
    .filter((ci) => communitySize(ci) <= 3)
    .map((ci) => ({ community: ci, size: communitySize(ci), papers: paperIds.filter((p) => communityByPaper[p] === ci).map((p) => truncate(titleByPaper.get(p) ?? "", 80)) }));
  const lowDegreePapers = paperIds
    .filter((p) => (projDegree.get(p) ?? 0) <= 1)
    .map((p) => ({ title: truncate(titleByPaper.get(p) ?? "", 80), projDegree: projDegree.get(p) ?? 0, library: primaryLib.get(p) ?? "general-only" }));

  const stats: Record<string, unknown> = {
    nodes: {
      papers: papers.length,
      claims: claims.length,
      methods: methodCanonToLabel.size,
      datasets: datasetCanonToLabel.size,
      concepts: conceptCanons.length,
      conceptMerges,
      total: nodes.length,
    },
    edges: countByKind(edges),
    projectionEdges: projEdges.length,
    communities: communityIndices.length,
    communityLabels: communityIndices.map((ci) => ({ index: ci, size: communitySize(ci), label: labelByCommunity.get(ci) ?? null })),
    ari: { vsLibrariesAll: round4(ariAll), vsLibrariesOnTopic: ariOnTopic === null ? null : round4(ariOnTopic), note: "vsLibrariesOnTopic restricts to papers in a real (non-general) library; vsLibrariesAll groups general-only papers as one label." },
    orphanReport: { tinyCommunities, lowDegreePapers },
    citations: citePairs.size,
    topAbc: abcScored.length,
  };

  // ---------------------------------------------------------------------
  // WRITE (transactional, immutable run)
  // ---------------------------------------------------------------------
  const [runRow] = await db.insert(webBuildRuns).values({ params, status: "running" }).returning({ id: webBuildRuns.id });
  const runId = runRow.id;
  try {
    await db.transaction(async (tx) => {
      // Communities first so nodes can carry a real FK.
      const communityIdByIndex = new Map<number, string>();
      for (const ci of communityIndices) {
        const t = communityTop.get(ci)!;
        const [row] = await tx.insert(webCommunities).values({ runId, communityIndex: ci, label: labelByCommunity.get(ci) ?? null, size: communitySize(ci), topConcepts: { concepts: t.concepts, methods: t.methods } }).returning({ id: webCommunities.id });
        communityIdByIndex.set(ci, row.id);
      }
      // Nodes, chunked; capture key -> uuid.
      const nodeIdByKey = new Map<string, string>();
      const nodeValues = nodes.map((n) => {
        const ci = communityByKey.get(n.key);
        return { runId, kind: n.kind, refTable: n.refTable, refId: n.refId, mergedFrom: n.mergedFrom, label: n.label, canonicalLabel: n.canonicalLabel, degree: degree.get(n.key) ?? 0, communityId: ci !== undefined ? communityIdByIndex.get(ci) ?? null : null, _key: n.key };
      });
      for (const chunk of chunked(nodeValues, 500)) {
        const inserted = await tx.insert(webNodes).values(chunk.map(({ _key, ...v }) => v)).returning({ id: webNodes.id });
        chunk.forEach((c, i) => nodeIdByKey.set(c._key, inserted[i].id));
      }
      // Edges, chunked, resolving node keys to ids.
      const edgeValues = edges
        .map((e) => {
          const src = nodeIdByKey.get(e.srcKey);
          const dst = nodeIdByKey.get(e.dstKey);
          if (!src || !dst) return null;
          return { runId, srcNodeId: src, dstNodeId: dst, kind: e.kind, weight: e.weight, provenance: e.provenance };
        })
        .filter((e): e is NonNullable<typeof e> => e !== null);
      for (const chunk of chunked(edgeValues, 1000)) await tx.insert(webEdges).values(chunk);
      // Bridges.
      if (bridges.length) for (const chunk of chunked(bridges.map((b) => ({ runId, kind: b.kind, score: b.score, payload: b.payload })), 500)) await tx.insert(webBridges).values(chunk);
      await tx.update(webBuildRuns).set({ status: "completed", completedAt: new Date(), stats }).where(sql`id = ${runId}`);
    });
    return { status: "completed", runId, stats };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(webBuildRuns).set({ status: "failed", completedAt: new Date(), error: message }).where(sql`id = ${runId}`);
    throw error;
  }
}

function countByKind(edges: EdgeSpec[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const e of edges) m[e.kind] = (m[e.kind] ?? 0) + 1;
  return m;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
