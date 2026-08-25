// ---------------------------------------------------------------------------
// SHARED TREE VISUAL BUILDER: one implementation of materials, per-instance
// color variation, contact shadows, and the lighting rig, consumed by BOTH
// the /botany-test scene and the narrative forest. The data-to-botany
// mapping (libraryToTreeParams, generateTree) is untouched; this layer only
// renders what the generator derives, richer.
//
// Determinism holds: all visual variation is seeded from the tree's own
// data seed, so the same library still renders the same tree.
// ---------------------------------------------------------------------------

import * as THREE from "three";
import type { BotanyConfig } from "@/lib/botany-config";
import { generateTree, type TreeParams } from "@/lib/botany";

type Track = <T extends { dispose(): void }>(x: T) => T;

export type SharedGeos = {
  branch: THREE.CylinderGeometry;
  leaf: THREE.PlaneGeometry;
  fruit: THREE.SphereGeometry;
  blossom: THREE.OctahedronGeometry;
  softTex: THREE.CanvasTexture;
};

function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeSoftTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.5, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

export function makeSharedGeos(cfg: BotanyConfig, track: Track): SharedGeos {
  return {
    branch: track(new THREE.CylinderGeometry(0.85, 1, 1, Math.max(5, Math.round(cfg.branchRadialSegments)))),
    leaf: track(new THREE.PlaneGeometry(1, 1)),
    fruit: track(new THREE.SphereGeometry(1, 12, 8)),
    blossom: track(new THREE.OctahedronGeometry(1, 1)),
    softTex: track(makeSoftTexture()),
  };
}

// The forest's lighting rig: warm key (azimuth-tunable), cool fill, soft
// rim/back so silhouettes separate from the dark ground.
export function makeLightRig(cfg: BotanyConfig): THREE.Light[] {
  const az = (cfg.lightKeyAzimuthDeg * Math.PI) / 180;
  const key = new THREE.DirectionalLight(new THREE.Color(cfg.lightKeyColor), cfg.lightKey);
  key.position.set(Math.cos(az) * 6, 7, Math.sin(az) * 6);
  const fill = new THREE.DirectionalLight(new THREE.Color(cfg.lightFillColor), cfg.lightFill);
  fill.position.set(-Math.cos(az) * 5, 2.5, Math.sin(az) * 3);
  const rim = new THREE.DirectionalLight(new THREE.Color(cfg.lightRimColor), cfg.lightRim);
  rim.position.set(0, 5, -6);
  const ambient = new THREE.AmbientLight(0xffffff, cfg.lightAmbient);
  return [key, fill, rim, ambient];
}

// Faint ground mist: one large soft additive plane per scene (not per tree).
export function makeMist(cfg: BotanyConfig, radius: number, track: Track, softTex: THREE.CanvasTexture): THREE.Mesh | null {
  if (cfg.mistOpacity <= 0) return null;
  const geo = track(new THREE.PlaneGeometry(radius * 2, radius * 2));
  const mat = track(
    new THREE.MeshBasicMaterial({
      map: softTex,
      color: new THREE.Color(cfg.glowColor),
      transparent: true,
      opacity: cfg.mistOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const mist = new THREE.Mesh(geo, mat);
  mist.rotation.x = -Math.PI / 2;
  mist.position.y = cfg.mistHeight;
  return mist;
}

// The honest one-line state caption for a tree's label (matches the
// generator's foliage rules exactly; nothing invented).
export function captionFromParams(p: TreeParams): string {
  if (!p.inLeaf) return "bare: no synthesis yet";
  const bits: string[] = [p.leafDensityMult >= 1 ? "in full leaf" : "in leaf, unaudited"];
  if (p.fruitCount > 0) bits.push(`${p.fruitCount} fruit`);
  if (p.blossomCount > 0) bits.push("in blossom");
  if (p.glow) bits.push("glowing");
  return bits.join(", ");
}

export type BuiltTree = {
  group: THREE.Group;
  stats: { branchInstances: number; leafInstances: number; effectiveVertices: number; drawCalls: number };
  labelAnchor: THREE.Vector3; // above the canopy, for the DOM label
};

// Build one tree's full visual from its (unchanged) generated geometry.
export function buildTreeVisual(params: TreeParams, cfg: BotanyConfig, shared: SharedGeos, track: Track): BuiltTree {
  const g = generateTree(params, cfg);
  const group = new THREE.Group();
  const dummy = new THREE.Object3D();
  const vrng = seededRng(params.seed ^ 0xc0105); // visual variation only, still data-seeded
  let drawCalls = 0;

  const setInstances = (mesh: THREE.InstancedMesh, list: typeof g.branches) => {
    list.forEach((inst, i) => {
      dummy.position.set(...inst.pos);
      dummy.quaternion.set(...inst.quat);
      dummy.scale.set(...inst.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };

  // BARK: gradient from base tone (thick segments) to tip tone (thin young
  // growth), with seeded per-segment variation. Per-instance colors over a
  // white-base standard material, so crevice-to-ridge tonal life comes from
  // the instance ramp plus real lighting, not a flat plastic fill.
  const barkBase = new THREE.Color(cfg.branchColor);
  const barkTip = new THREE.Color(cfg.barkTipColor);
  const barkMat = track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: cfg.barkRoughness, metalness: 0 }));
  const branchesMesh = new THREE.InstancedMesh(shared.branch, barkMat, Math.max(1, g.branches.length));
  setInstances(branchesMesh, g.branches);
  branchesMesh.count = g.branches.length;
  const maxR = Math.max(1e-6, params.trunkRadius);
  const c = new THREE.Color();
  g.branches.forEach((inst, i) => {
    const t = Math.min(1, inst.scale[0] / maxR); // thick = base, thin = tip
    c.copy(barkTip).lerp(barkBase, t);
    const v = 1 + (vrng() * 2 - 1) * cfg.barkVariation;
    c.multiplyScalar(v);
    branchesMesh.setColorAt(i, c);
  });
  if (branchesMesh.instanceColor) branchesMesh.instanceColor.needsUpdate = true;
  group.add(branchesMesh);
  drawCalls += 1;

  // FOLIAGE: per-leaf color spread around the derived community hue, a
  // translucent feel from emissive, and an optional soft additive canopy
  // layer sharing the same instance matrices (one extra draw call).
  const foliage = new THREE.Color(params.foliageColor);
  if (params.leafDesat > 0) foliage.lerp(barkBase, params.leafDesat);
  const leafBase = params.inLeaf ? foliage : new THREE.Color(cfg.budColor);
  const leafMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.65,
      metalness: 0,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: cfg.leafOpacity,
      emissive: leafBase.clone().multiplyScalar(cfg.leafTranslucency),
    }),
  );
  const leavesMesh = new THREE.InstancedMesh(shared.leaf, leafMat, Math.max(1, g.leaves.length));
  setInstances(leavesMesh, g.leaves);
  leavesMesh.count = g.leaves.length;
  const hsl = { h: 0, s: 0, l: 0 };
  leafBase.getHSL(hsl);
  g.leaves.forEach((_, i) => {
    const spread = cfg.leafColorSpread;
    c.setHSL(
      (hsl.h + (vrng() * 2 - 1) * spread * 0.15 + 1) % 1,
      Math.min(1, Math.max(0, hsl.s + (vrng() * 2 - 1) * spread * 0.4)),
      Math.min(0.85, Math.max(0.1, hsl.l + (vrng() * 2 - 1) * spread * 0.5)),
    );
    leavesMesh.setColorAt(i, c);
  });
  if (leavesMesh.instanceColor) leavesMesh.instanceColor.needsUpdate = true;
  group.add(leavesMesh);
  drawCalls += 1;

  if (cfg.leafGlowOpacity > 0 && params.inLeaf && g.leaves.length > 0) {
    const glowMat = track(
      new THREE.MeshBasicMaterial({
        color: leafBase,
        transparent: true,
        opacity: cfg.leafGlowOpacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    const glowLeaves = new THREE.InstancedMesh(shared.leaf, glowMat, leavesMesh.count);
    glowLeaves.instanceMatrix = leavesMesh.instanceMatrix; // shared transforms
    glowLeaves.count = leavesMesh.count;
    group.add(glowLeaves);
    drawCalls += 1;
  }

  // FRUIT AND BLOSSOM: dimensional little objects with a soft specular.
  if (g.fruit.length > 0) {
    const fruitMat = track(
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(cfg.fruitColor),
        roughness: cfg.fruitRoughness,
        metalness: 0.05,
        emissive: new THREE.Color(cfg.fruitColor).multiplyScalar(cfg.fruitEmissive),
      }),
    );
    const m = new THREE.InstancedMesh(shared.fruit, fruitMat, g.fruit.length);
    setInstances(m, g.fruit);
    group.add(m);
    drawCalls += 1;
  }
  if (g.blossoms.length > 0) {
    const blossomMat = track(
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(cfg.blossomColor),
        roughness: cfg.blossomRoughness,
        metalness: 0,
        emissive: new THREE.Color(cfg.blossomColor).multiplyScalar(cfg.blossomEmissive),
      }),
    );
    const m = new THREE.InstancedMesh(shared.blossom, blossomMat, g.blossoms.length);
    setInstances(m, g.blossoms);
    group.add(m);
    drawCalls += 1;
  }

  // Maturity glow sprites (experiment + document done).
  for (const tip of g.glowTips) {
    const m = track(new THREE.SpriteMaterial({ map: shared.softTex, color: new THREE.Color(cfg.glowColor), transparent: true, opacity: cfg.glowOpacity, blending: THREE.AdditiveBlending, depthWrite: false }));
    const sprite = new THREE.Sprite(m);
    sprite.position.set(...tip);
    sprite.scale.setScalar(0.5);
    group.add(sprite);
  }
  if (g.glowTips.length > 0) drawCalls += 1;

  // CONTACT SHADOW: a soft radial decal so the tree sits planted (chosen
  // over real shadow maps for cost; stated in docs).
  if (cfg.contactShadowOpacity > 0) {
    const r = params.heightScale * cfg.contactShadowScale * 0.45;
    const shadowGeo = track(new THREE.CircleGeometry(r, 24));
    const shadowMat = track(new THREE.MeshBasicMaterial({ map: shared.softTex, color: 0x000000, transparent: true, opacity: cfg.contactShadowOpacity, depthWrite: false }));
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.012;
    group.add(shadow);
    drawCalls += 1;
  }

  return {
    group,
    stats: {
      branchInstances: g.branches.length,
      leafInstances: g.leaves.length,
      effectiveVertices: g.branches.length * (shared.branch.attributes.position.count ?? 42) + g.leaves.length * 4 + g.fruit.length * 96 + g.blossoms.length * 42,
      drawCalls,
    },
    labelAnchor: new THREE.Vector3(0, g.height + 0.35, 0),
  };
}
