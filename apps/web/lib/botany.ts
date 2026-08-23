// ---------------------------------------------------------------------------
// BOTANY: a library rendered as a tree. CORE PRINCIPLE: every visual
// property DERIVES from real data about that library; nothing is random or
// hallucinated. This is deterministic parametric generation. The seeded
// jitter shapes the organic form, but the seed is the library's id, so the
// same library is the same tree on every render.
//
// THE MAPPING (each rule tunable via BotanyConfig):
//   paper count               -> primary branch count, height, trunk girth
//   internal citation density -> recursion depth, children per node, canopy
//   synthesis done            -> in leaf (missing -> bare with buds)
//   critic done               -> full healthy foliage (missing -> sparse,
//                                desaturated)
//   metric rows (bucketed)    -> fruit count
//   cross-domain done         -> blossoms
//   experiment + document     -> canopy glow
//   community                 -> foliage hue, harmonized into the green world
//   library id                -> the seed (FNV-1a 32-bit of the uuid string)
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { COLOR, PORTAL } from "./design-tokens";
import type { BotanyConfig } from "./botany-config";

export type StageLite = "done" | "stale" | "missing" | "none_found";

export type LibraryBotanyInput = {
  id: string;
  name: string;
  paperCount: number;
  // Average internal citation edges per paper (edges where BOTH endpoints
  // are in this library), computed from the real citations table.
  internalCitationDensity: number;
  internalCitationEdges: number;
  communityIndex: number | null;
  stages: {
    synthesis: StageLite;
    critic: StageLite;
    metricsRows: number;
    crossDomain: StageLite;
    experiment: StageLite;
    document: StageLite;
  };
};

export type TreeParams = {
  seed: number;
  libraryName: string;
  primaryBranches: number;
  heightScale: number;
  trunkRadius: number;
  depth: number;
  childrenPerBranch: number;
  canopyDensity: number;
  inLeaf: boolean; // synthesis done or stale (a stale synthesis still leafs)
  leafDensityMult: number; // critic health
  leafDesat: number;
  fruitCount: number;
  blossomCount: number;
  glow: boolean;
  foliageColor: string;
  // The honesty readout: every mapping stated next to the tree.
  derived: { label: string; value: string }[];
};

// FNV-1a 32-bit: the documented seed of a library's tree.
export function librarySeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// Community hue harmonized into the green/black/white world: mix the
// community's palette color toward the living green so the forest still
// reads as one place while libraries stay tellable apart.
function harmonizedFoliage(communityIndex: number | null, mix: number): string {
  const base = new THREE.Color(COLOR.green);
  if (communityIndex === null) return `#${base.getHexString()}`;
  const community = new THREE.Color(PORTAL.communityPalette[communityIndex % PORTAL.communityPalette.length]);
  return `#${base.clone().lerp(community, clamp(mix, 0, 1)).getHexString()}`;
}

// PURE: real library state in, tree parameters out. No I/O, no clock, no
// randomness (the seed is data).
export function libraryToTreeParams(input: LibraryBotanyInput, cfg: BotanyConfig): TreeParams {
  const seed = librarySeed(input.id);
  const primaryBranches = clamp(cfg.branchCountBase + Math.floor(input.paperCount / cfg.branchPerPapers), cfg.branchCountBase, cfg.branchCountMax);
  const heightScale = clamp(cfg.heightBase + input.paperCount * cfg.heightPerPaper, cfg.heightBase, cfg.heightMax);
  const trunkRadius = clamp(cfg.trunkRadiusBase + input.paperCount * cfg.trunkRadiusPerPaper, cfg.trunkRadiusBase, cfg.trunkRadiusMax);

  const d = input.internalCitationDensity;
  const depth = clamp(cfg.depthBase + (d > cfg.densityDepthT1 ? 1 : 0) + (d > cfg.densityDepthT2 ? 1 : 0), cfg.depthBase, cfg.depthMax);
  const childrenPerBranch = clamp(Math.round(cfg.childrenBase + Math.min(d, 2) * cfg.childrenDensityMult), cfg.childrenBase, cfg.childrenMax);
  const canopyDensity = clamp(cfg.canopyDensityBase + Math.min(d / 2, 1) * cfg.canopyDensityFromCitations, 0, 1.2);

  const inLeaf = input.stages.synthesis !== "missing";
  const criticDone = input.stages.critic === "done";
  const leafDensityMult = criticDone ? 1 : cfg.criticLeafDensity;
  const leafDesat = criticDone ? 0 : cfg.criticDesat;

  let bucket = 0;
  for (const t of cfg.fruitBuckets) if (input.stages.metricsRows >= t) bucket += 1;
  const fruitCount = bucket * cfg.fruitPerBucket;

  const blossomCount = input.stages.crossDomain === "done" ? cfg.blossomCount : 0;
  const glow = input.stages.experiment === "done" && input.stages.document === "done";

  const derived: TreeParams["derived"] = [
    { label: `${input.paperCount} papers`, value: `${primaryBranches} primary branches, height x${heightScale.toFixed(2)}` },
    { label: `${input.internalCitationEdges} internal citations (${d.toFixed(2)}/paper)`, value: `depth ${depth}, ${childrenPerBranch} children/node, canopy ${(canopyDensity * 100).toFixed(0)}%` },
    { label: `synthesis ${input.stages.synthesis}`, value: inLeaf ? "in leaf" : "bare, budding" },
    { label: `critic ${input.stages.critic}`, value: criticDone ? "full healthy foliage" : "sparse, desaturated foliage" },
    { label: `${input.stages.metricsRows} metric rows`, value: fruitCount > 0 ? `${fruitCount} fruit (bucket ${bucket})` : "no fruit" },
    { label: `cross-domain ${input.stages.crossDomain}`, value: blossomCount > 0 ? `${blossomCount} blossoms` : "no blossoms" },
    { label: `experiment ${input.stages.experiment}, document ${input.stages.document}`, value: glow ? "canopy glow" : "no glow" },
    { label: `community ${input.communityIndex ?? "none"}`, value: "foliage hue" },
    { label: "seed", value: `0x${seed.toString(16)}` },
  ];

  return {
    seed,
    libraryName: input.name,
    primaryBranches,
    heightScale,
    trunkRadius,
    depth,
    childrenPerBranch,
    canopyDensity,
    inLeaf,
    leafDensityMult,
    leafDesat,
    fruitCount,
    blossomCount,
    glow,
    foliageColor: harmonizedFoliage(input.communityIndex, cfg.communityMix),
    derived,
  };
}

// ---------------------------------------------------------------------------
// THE GENERATOR: recursive seeded branching to instance transforms. All
// numbers come from params (data) and cfg (tunables). The scene component
// feeds these arrays into InstancedMesh, so a whole tree is a handful of
// draw calls regardless of complexity.
// ---------------------------------------------------------------------------

export type Instance = { pos: [number, number, number]; quat: [number, number, number, number]; scale: [number, number, number] };

export type TreeGeometry = {
  branches: Instance[]; // unit cylinder (y-up) transforms
  leaves: Instance[]; // unit plane transforms
  fruit: Instance[];
  blossoms: Instance[];
  glowTips: [number, number, number][];
  height: number;
  stats: { branchSegments: number; tips: number; leaves: number };
};

const UP = new THREE.Vector3(0, 1, 0);

export function generateTree(params: TreeParams, cfg: BotanyConfig): TreeGeometry {
  const rng = mulberry32(params.seed);
  const branches: Instance[] = [];
  const leaves: Instance[] = [];
  const fruit: Instance[] = [];
  const blossoms: Instance[] = [];
  const glowTips: [number, number, number][] = [];
  const tips: THREE.Vector3[] = [];
  let maxY = 0;

  const q = new THREE.Quaternion();
  const tmp = new THREE.Vector3();
  const trunkLen = params.heightScale;

  // One branch = a short polyline of tapered cylinder segments with seeded
  // organic bend. Children leave from the end node (and one mid node) at
  // golden-angle azimuths. Depth and children-per-node come from the data.
  function grow(origin: THREE.Vector3, dir: THREE.Vector3, length: number, radius: number, depth: number, azimuthSeed: number): void {
    const segments = cfg.segmentsPerBranch;
    const segLen = length / segments;
    let p = origin.clone();
    const d = dir.clone().normalize();
    const midPoints: { point: THREE.Vector3; dir: THREE.Vector3 }[] = [];
    for (let i = 0; i < segments; i++) {
      tmp.set(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).cross(d).normalize();
      d.addScaledVector(tmp, cfg.curvature * (rng() * 2 - 1)).addScaledVector(UP, cfg.gravityBias).normalize();
      const r0 = radius * (1 - (1 - cfg.taper) * (i / segments));
      const r1 = radius * (1 - (1 - cfg.taper) * ((i + 1) / segments));
      const mid = p.clone().addScaledVector(d, segLen / 2);
      q.setFromUnitVectors(UP, d);
      branches.push({ pos: [mid.x, mid.y, mid.z], quat: [q.x, q.y, q.z, q.w], scale: [(r0 + r1) / 2, segLen, (r0 + r1) / 2] });
      p = p.addScaledVector(d, segLen);
      if (i === Math.floor(segments / 2)) midPoints.push({ point: p.clone(), dir: d.clone() });
      maxY = Math.max(maxY, p.y);
    }
    if (depth >= params.depth || length * cfg.lengthRatio < cfg.minBranchLength || branches.length >= cfg.maxBranchSegments || tips.length >= cfg.maxTips) {
      tips.push(p.clone());
      return;
    }
    const spawnPoints = [{ point: p, dir: d }, ...midPoints];
    let azimuth = azimuthSeed;
    for (const sp of spawnPoints) {
      // The mid node spawns at most one child; the end node spawns the full
      // data-driven count. This keeps fan-out linear in children, not double.
      const kidsHere = sp === spawnPoints[0] ? params.childrenPerBranch : 1;
      for (let k = 0; k < kidsHere; k++) {
        azimuth += cfg.goldenAngle;
        const angle = cfg.branchAngle + (rng() * 2 - 1) * cfg.angleJitter;
        const axis = tmp.set(Math.cos(azimuth), 0, Math.sin(azimuth)).cross(sp.dir);
        const child = sp.dir
          .clone()
          .applyAxisAngle(axis.lengthSq() < 1e-6 ? new THREE.Vector3(1, 0, 0) : axis.clone().normalize(), angle)
          .applyAxisAngle(sp.dir, azimuth)
          .normalize();
        grow(sp.point.clone(), child, length * cfg.lengthRatio * (0.85 + rng() * 0.3), radius * cfg.radiusRatio, depth + 1, azimuth);
      }
      if (sp !== spawnPoints[0]) break; // only one mid node also spawns
    }
  }

  // The trunk: gentler curvature, stronger reach; then the primary split
  // fans out PAPER-COUNT-many branches at golden-angle azimuths.
  {
    const segLen = (trunkLen * 0.55) / cfg.segmentsPerBranch;
    let p = new THREE.Vector3(0, 0, 0);
    const d = UP.clone();
    for (let i = 0; i < cfg.segmentsPerBranch; i++) {
      tmp.set(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).cross(d).normalize();
      d.addScaledVector(tmp, cfg.curvature * 0.4 * (rng() * 2 - 1)).addScaledVector(UP, cfg.gravityBias * 2).normalize();
      const r0 = params.trunkRadius * (1 - (1 - cfg.taper) * (i / cfg.segmentsPerBranch) * 0.5);
      const mid = p.clone().addScaledVector(d, segLen / 2);
      q.setFromUnitVectors(UP, d);
      branches.push({ pos: [mid.x, mid.y, mid.z], quat: [q.x, q.y, q.z, q.w], scale: [r0, segLen, r0] });
      p = p.addScaledVector(d, segLen);
      maxY = Math.max(maxY, p.y);
    }
    let azimuth = rng() * Math.PI * 2;
    for (let k = 0; k < params.primaryBranches; k++) {
      azimuth += cfg.goldenAngle;
      const angle = cfg.branchAngle + (rng() * 2 - 1) * cfg.angleJitter;
      const perp = new THREE.Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
      const child = d.clone().applyAxisAngle(perp, angle).normalize();
      grow(p.clone(), child, trunkLen * 0.6 * (0.85 + rng() * 0.3), params.trunkRadius * cfg.radiusRatio, 1, azimuth);
    }
  }

  // FOLIAGE. In leaf: leaves per tip from canopy density and critic health.
  // Bare: a fraction of tips carry small buds (life waiting, never an error
  // state).
  const leafRng = mulberry32(params.seed ^ 0x1eaf);
  if (params.inLeaf) {
    const perTip = Math.max(1, Math.round(cfg.leavesPerTip * params.canopyDensity * params.leafDensityMult));
    for (const tip of tips) {
      for (let i = 0; i < perTip; i++) {
        const off = new THREE.Vector3((leafRng() * 2 - 1) * cfg.leafJitter, (leafRng() * 2 - 1) * cfg.leafJitter, (leafRng() * 2 - 1) * cfg.leafJitter);
        const pos = tip.clone().add(off);
        q.setFromEuler(new THREE.Euler(leafRng() * Math.PI, leafRng() * Math.PI, leafRng() * Math.PI));
        const s = cfg.leafSize * (0.7 + leafRng() * 0.6);
        leaves.push({ pos: [pos.x, pos.y, pos.z], quat: [q.x, q.y, q.z, q.w], scale: [s, s, s] });
      }
    }
  } else {
    for (const tip of tips) {
      if (leafRng() > cfg.budFraction) continue;
      const s = cfg.leafSize * cfg.budScale;
      q.setFromEuler(new THREE.Euler(leafRng() * Math.PI, leafRng() * Math.PI, leafRng() * Math.PI));
      leaves.push({ pos: [tip.x, tip.y, tip.z], quat: [q.x, q.y, q.z, q.w], scale: [s, s, s] });
    }
  }

  // ORNAMENTS on seeded tip choices: fruit (metrics buckets) and blossoms
  // (cross-domain). Counts come from params (data), never from randomness.
  const ornRng = mulberry32(params.seed ^ 0xf407);
  const pickTip = () => tips[Math.floor(ornRng() * tips.length)] ?? new THREE.Vector3(0, trunkLen, 0);
  for (let i = 0; i < params.fruitCount; i++) {
    const t = pickTip();
    const s = cfg.fruitSize * (0.8 + ornRng() * 0.4);
    fruit.push({ pos: [t.x, t.y - cfg.fruitSize * 1.5, t.z], quat: [0, 0, 0, 1], scale: [s, s, s] });
  }
  for (let i = 0; i < params.blossomCount; i++) {
    const t = pickTip();
    q.setFromEuler(new THREE.Euler(ornRng() * Math.PI, ornRng() * Math.PI, 0));
    const s = cfg.blossomSize * (0.8 + ornRng() * 0.4);
    blossoms.push({ pos: [t.x, t.y, t.z], quat: [q.x, q.y, q.z, q.w], scale: [s, s, s] });
  }

  // MATURITY GLOW (experiment + document done): a few soft lights in the
  // canopy, on seeded tips.
  if (params.glow) {
    const glowRng = mulberry32(params.seed ^ 0x9107);
    const n = Math.max(4, Math.round(tips.length / 6));
    for (let i = 0; i < n; i++) {
      const t = tips[Math.floor(glowRng() * tips.length)] ?? new THREE.Vector3(0, trunkLen, 0);
      glowTips.push([t.x, t.y, t.z]);
    }
  }

  return {
    branches,
    leaves,
    fruit,
    blossoms,
    glowTips,
    height: maxY,
    stats: { branchSegments: branches.length, tips: tips.length, leaves: leaves.length },
  };
}
