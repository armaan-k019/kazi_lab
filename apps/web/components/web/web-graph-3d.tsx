"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { WebCommunity, WebGraphEdge, WebGraphNode } from "@/lib/types";

// ---------------------------------------------------------------------------
// All tuning constants centralized here per the codebase convention.
// ---------------------------------------------------------------------------
const BG = 0x0b0d10;
const HEIGHT = 560;
const LAYOUT_SCALE = 52; // scale normalized t-SNE coords into the scene
const CAMERA_START = 72; // close enough that the cloud fills the frame
const PIXEL_RATIO_CAP = 2; // retina displays do not get to tank the frame rate

// Depth and atmosphere. FogExp2 so far nodes recede into the background color
// rather than clipping. The same falloff is applied inside the point/line
// shaders (ShaderMaterial does not inherit scene fog automatically).
const FOG_DENSITY = 0.006;

// Points: soft circular sprites with a radial alpha falloff and a small bright
// core, additive-blended so dense regions accumulate light.
const POINT_SIZE_MIN = 2.8; // shader size units (world-ish, size-attenuated)
const POINT_SIZE_MAX = 8.0;
const POINT_SIZE_SCALE = 300; // gl_PointSize = size * POINT_SIZE_SCALE / depth
const HOVER_SCALE = 1.45; // hovered point grows by this factor
const DIM_ALPHA = 0.14; // fully dimmed nodes keep this alpha multiple, never hidden
const LEGEND_HOVER_DIM = 0.55; // partial dim mix (0..1) when hovering a legend chip

// Community palette: desaturated-but-luminous hues, calm not neon. Index i
// colors community i mod length. Unassigned nodes get the neutral last-ish grey.
const COMMUNITY_PALETTE: number[] = [
  0x7da2d9, // slate blue
  0x8fc4a5, // sage
  0xc79bd9, // lilac
  0xd98f8f, // muted rose
  0x76bcc4, // teal mist
  0xccb37a, // ochre
  0x9b90d9, // periwinkle
  0xd9a3c0, // dusty pink
  0x90b878, // moss
  0x8a95a8, // neutral grey-blue
];
const UNASSIGNED_COLOR = 0x8a95a8;

// Edges. ON by default; two visual classes. Intra-community edges are faint and
// community-hued, kept only for the top-K strongest per node so structure shows
// without a hairball. Inter-community bridges are brighter, warmer, and arc
// gently so long spans read as bridges instead of cutting through clusters.
const MAX_EDGES_DRAWN = 3000; // documented cap, selected by weight
const INTRA_TOP_K = 4; // strongest intra-community edges kept per node
const INTRA_ALPHA = 0.10;
const BRIDGE_ALPHA = 0.42;
const BRIDGE_COLOR = 0xe0b48a; // warm neutral so bridges visually pop
const BRIDGE_ARC_SEGMENTS = 10; // bezier samples per bridge edge
const BRIDGE_ARC_LIFT = 0.14; // arc height as a fraction of edge length
const EGO_EDGE_BOOST = 1.8; // edge alpha multiplier inside a selected ego network
const EDGE_DIM_FACTOR = 0.12; // edges outside the ego network keep this alpha fraction

// Community identity: billboarded centroid labels + a soft halo sprite at the
// centroid scaled to the community's spatial extent. The sprite halo was chosen
// over a convex hull because it is one draw call per community, needs no hull
// computation, and reads clearly at this corpus size (documented choice).
const HALO_OPACITY = 0.055;
const HALO_SCALE = 2.6; // halo diameter = extent RMS radius x this
const LABEL_COLOR = "#dde3ec";
const LABEL_MAX_OPACITY = 0.85;
const LABEL_FADE_NEAR = 14; // camera closer than this to a centroid fades its label
const LABEL_FADE_RANGE = 14;
const LABEL_WORLD_HEIGHT = 3.2; // sprite height in world units

// Interaction.
const DAMPING_FACTOR = 0.06; // weighted, smooth orbit
const IDLE_ROTATE_DELAY_MS = 5000; // idle time before auto-rotation engages
const IDLE_ROTATE_SPEED = 0.4; // OrbitControls autoRotateSpeed units (slow)
const IDLE_ROTATE_EASE = 0.02; // per-frame ease toward the target speed
const CAMERA_EASE_MS = 420; // selection/community/reset camera easing duration
const RAY_POINT_THRESHOLD = 1.5; // raycast pick radius in world units
const COMMUNITY_FRAME_DISTANCE = 3.2; // camera distance = extent x this when framing

// Bloom: subtle. Threshold set so only bright additive cores bloom; the goal is
// atmosphere, not a glare bath.
const BLOOM_STRENGTH = 0.5;
const BLOOM_RADIUS = 0.55;
const BLOOM_THRESHOLD = 0.6;

// Background star dust: a faint static field for parallax depth. Deterministic
// (seeded) so the scene is stable across mounts.
const STAR_COUNT = 240;
const STAR_ALPHA = 0.32;
const STAR_SIZE = 1.1;

function communityColor(c: number | null): number {
  return c === null || c < 0 ? UNASSIGNED_COLOR : COMMUNITY_PALETTE[c % COMMUNITY_PALETTE.length];
}

// Small seeded PRNG for the star field (deterministic scene across mounts).
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

// Soft radial sprite texture shared by the halos.
function makeRadialTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Billboarded text label texture for a community.
function makeLabelTexture(text: string): { tex: THREE.CanvasTexture; aspect: number } {
  const font = "500 30px ui-sans-serif, system-ui, -apple-system, sans-serif";
  const pad = 12;
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = font;
  const w = Math.ceil(measure.measureText(text).width) + pad * 2;
  const h = 44 + pad * 2;
  const canvas = document.createElement("canvas");
  const scale = 2; // retina-sharp
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 8;
  ctx.fillStyle = LABEL_COLOR;
  ctx.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, aspect: w / h };
}

// Point shader: soft circular sprite, additive core glow, manual FogExp2
// attenuation, per-point size/color/highlight/dim.
const POINT_VERTEX = `
attribute float aSize;
attribute vec3 aColor;
attribute float aHighlight;
attribute float aDim;
varying vec3 vColor;
varying float vHighlight;
varying float vDim;
varying float vFog;
uniform float uFogDensity;
void main() {
  vColor = aColor;
  vHighlight = aHighlight;
  vDim = aDim;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float depth = -mv.z;
  float scale = 1.0 + ${(HOVER_SCALE - 1).toFixed(2)} * aHighlight;
  gl_PointSize = aSize * scale * (${POINT_SIZE_SCALE.toFixed(1)} / max(depth, 1.0));
  float f = uFogDensity * depth;
  vFog = exp(-f * f);
  gl_Position = projectionMatrix * mv;
}
`;
const POINT_FRAGMENT = `
varying vec3 vColor;
varying float vHighlight;
varying float vDim;
varying float vFog;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv) * 2.0;
  if (d > 1.0) discard;
  // Bright opaque-ish core + soft radial glow: luminous, not confetti.
  float core = smoothstep(0.38, 0.0, d);
  float glow = pow(1.0 - d, 2.4);
  float alpha = core * 1.0 + glow * 0.6;
  // Dimmed nodes also desaturate toward grey so the ego network reads clearly.
  float grey = dot(vColor, vec3(0.299, 0.587, 0.114));
  vec3 base = mix(vColor, vec3(grey), vDim * 0.65);
  alpha *= mix(1.0, ${DIM_ALPHA.toFixed(2)}, vDim);
  vec3 col = base * (0.9 + 0.7 * vHighlight) + vec3(0.5) * core * 0.35 * (1.0 + vHighlight);
  gl_FragColor = vec4(col * alpha * vFog, alpha * vFog);
}
`;

// Line shader: per-vertex color + alpha, manual FogExp2 attenuation.
const LINE_VERTEX = `
attribute vec3 aColor;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
varying float vFog;
uniform float uFogDensity;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float f = uFogDensity * -mv.z;
  vFog = exp(-f * f);
  gl_Position = projectionMatrix * mv;
}
`;
const LINE_FRAGMENT = `
varying vec3 vColor;
varying float vAlpha;
varying float vFog;
void main() {
  gl_FragColor = vec4(vColor * vAlpha * vFog, vAlpha * vFog);
}
`;

type HoverInfo = { label: string; community: number | null; influence: number; x: number; y: number };

// Imperative scene handle: React state changes call into this instead of
// rebuilding the scene.
type SceneApi = {
  setEdgeMode(showEdges: boolean, bridgesOnly: boolean): void;
  setSelection(refId: string | null, expand: boolean): void;
  setLegendEmphasis(community: number | null, isolate: boolean): void;
  resetView(): void;
};

export function WebGraph3D({
  nodes,
  edges,
  communities,
  onSelect,
}: {
  nodes: WebGraphNode[];
  edges: WebGraphEdge[];
  communities: WebCommunity[];
  onSelect: (refId: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<SceneApi | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [showEdges, setShowEdges] = useState(true); // edges are the legibility win: ON by default
  const [bridgesOnly, setBridgesOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [isolated, setIsolated] = useState<number | null>(null);
  const [drawnEdgeCounts, setDrawnEdgeCounts] = useState<{ intra: number; bridge: number } | null>(null);
  // Keep a stable ref to the click handler so the scene never captures stale props.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Only papers that have coordinates can be placed.
  const placed = useMemo(() => nodes.filter((n) => n.x !== null && n.y !== null && n.z !== null && n.refId), [nodes]);
  const commLabel = useMemo(() => new Map(communities.map((c) => [c.index, c.label])), [communities]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || placed.length === 0) return;
    const width = mount.clientWidth || 800;
    const height = HEIGHT;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);
    scene.fog = new THREE.FogExp2(BG, FOG_DENSITY);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 2000);
    camera.position.set(0, 0, CAMERA_START);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    // Subtle bloom so bright additive cores glow; threshold keeps it restrained.
    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP));
    composer.setSize(width, height);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = DAMPING_FACTOR;

    // -----------------------------------------------------------------------
    // Layout: normalize coordinates to a centered cube.
    // -----------------------------------------------------------------------
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const n of placed) {
      minX = Math.min(minX, n.x!); maxX = Math.max(maxX, n.x!);
      minY = Math.min(minY, n.y!); maxY = Math.max(maxY, n.y!);
      minZ = Math.min(minZ, n.z!); maxZ = Math.max(maxZ, n.z!);
    }
    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    const pos = placed.map((n) => new THREE.Vector3(((n.x! - cx) / span) * LAYOUT_SCALE, ((n.y! - cy) / span) * LAYOUT_SCALE, ((n.z! - cz) / span) * LAYOUT_SCALE));
    const indexByRef = new Map<string, number>();
    placed.forEach((n, i) => indexByRef.set(n.refId!, i));

    // -----------------------------------------------------------------------
    // Points: soft additive sprites, size by influence, color by community.
    // -----------------------------------------------------------------------
    const n = placed.length;
    const maxInfluence = Math.max(1, ...placed.map((p) => p.influence));
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    const highlights = new Float32Array(n);
    const dims = new Float32Array(n);
    const tmpColor = new THREE.Color();
    for (let i = 0; i < n; i++) {
      positions[i * 3] = pos[i].x;
      positions[i * 3 + 1] = pos[i].y;
      positions[i * 3 + 2] = pos[i].z;
      tmpColor.setHex(communityColor(placed[i].community));
      // Bridge papers get a slightly warmer, brighter core so they pop gently.
      if (placed[i].isBridge) tmpColor.lerp(new THREE.Color(BRIDGE_COLOR), 0.35);
      colors[i * 3] = tmpColor.r;
      colors[i * 3 + 1] = tmpColor.g;
      colors[i * 3 + 2] = tmpColor.b;
      sizes[i] = POINT_SIZE_MIN + (POINT_SIZE_MAX - POINT_SIZE_MIN) * Math.sqrt(placed[i].influence / maxInfluence);
    }
    const pointGeo = new THREE.BufferGeometry();
    pointGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    pointGeo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    pointGeo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    pointGeo.setAttribute("aHighlight", new THREE.BufferAttribute(highlights, 1));
    pointGeo.setAttribute("aDim", new THREE.BufferAttribute(dims, 1));
    const pointMat = new THREE.ShaderMaterial({
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      uniforms: { uFogDensity: { value: FOG_DENSITY } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    const points = new THREE.Points(pointGeo, pointMat);
    scene.add(points);

    // -----------------------------------------------------------------------
    // Star dust: faint deterministic background field for parallax depth.
    // -----------------------------------------------------------------------
    const starRand = mulberry32(20260723);
    const starPositions = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      // Random direction on a shell between 4x and 8x the layout radius.
      const theta = starRand() * Math.PI * 2;
      const phi = Math.acos(2 * starRand() - 1);
      const r = LAYOUT_SCALE * (4 + 4 * starRand());
      starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPositions[i * 3 + 2] = r * Math.cos(phi);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({ color: 0x9aa4b8, size: STAR_SIZE, sizeAttenuation: false, transparent: true, opacity: STAR_ALPHA, depthWrite: false });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);

    // -----------------------------------------------------------------------
    // Edges: two visual classes. Intra-community (faint, community-hued,
    // top-K per node) and inter-community bridges (brighter, warm, arced).
    // -----------------------------------------------------------------------
    type DrawnEdge = { a: number; b: number; weight: number; bridge: boolean };
    const eligible: DrawnEdge[] = [];
    for (const e of edges) {
      if (!e.src || !e.dst) continue;
      const a = indexByRef.get(e.src);
      const b = indexByRef.get(e.dst);
      if (a === undefined || b === undefined || a === b) continue;
      const ca = placed[a].community;
      const cb = placed[b].community;
      eligible.push({ a, b, weight: e.weight, bridge: ca === null || cb === null || ca !== cb });
    }
    // Bridges first (they are the interesting objects), then intra top-K per
    // node, then the global cap by weight.
    const bridgeEdges = eligible.filter((e) => e.bridge).sort((x, y) => y.weight - x.weight);
    const intraAll = eligible.filter((e) => !e.bridge).sort((x, y) => y.weight - x.weight);
    const perNodeCount = new Map<number, number>();
    const intraEdges: DrawnEdge[] = [];
    for (const e of intraAll) {
      const na = perNodeCount.get(e.a) ?? 0;
      const nb = perNodeCount.get(e.b) ?? 0;
      if (na >= INTRA_TOP_K && nb >= INTRA_TOP_K) continue;
      perNodeCount.set(e.a, na + 1);
      perNodeCount.set(e.b, nb + 1);
      intraEdges.push(e);
    }
    const bridgeBudget = Math.min(bridgeEdges.length, MAX_EDGES_DRAWN);
    const intraBudget = Math.min(intraEdges.length, MAX_EDGES_DRAWN - bridgeBudget);
    const drawnBridges = bridgeEdges.slice(0, bridgeBudget);
    const drawnIntra = intraEdges.slice(0, intraBudget);
    setDrawnEdgeCounts({ intra: drawnIntra.length, bridge: drawnBridges.length });

    // Adjacency over the DRAWN edges (the ego network highlights what the eye
    // can actually follow; documented choice).
    const adjacency = new Map<number, Set<number>>();
    const addAdj = (a: number, b: number) => {
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      adjacency.get(a)!.add(b);
    };
    for (const e of [...drawnIntra, ...drawnBridges]) {
      addAdj(e.a, e.b);
      addAdj(e.b, e.a);
    }

    const maxWeight = Math.max(1e-6, ...eligible.map((e) => e.weight));

    // Intra-community segments: straight lines, per-vertex community hue.
    const intraVertCount = drawnIntra.length * 2;
    const intraPos = new Float32Array(intraVertCount * 3);
    const intraCol = new Float32Array(intraVertCount * 3);
    const intraBaseAlpha = new Float32Array(intraVertCount);
    const intraAlpha = new Float32Array(intraVertCount);
    drawnIntra.forEach((e, k) => {
      const w = INTRA_ALPHA * (0.5 + 0.5 * (e.weight / maxWeight));
      for (const [slot, idx] of [[0, e.a], [1, e.b]] as const) {
        const v = k * 2 + slot;
        intraPos[v * 3] = pos[idx].x;
        intraPos[v * 3 + 1] = pos[idx].y;
        intraPos[v * 3 + 2] = pos[idx].z;
        tmpColor.setHex(communityColor(placed[idx].community));
        intraCol[v * 3] = tmpColor.r;
        intraCol[v * 3 + 1] = tmpColor.g;
        intraCol[v * 3 + 2] = tmpColor.b;
        intraBaseAlpha[v] = w;
        intraAlpha[v] = w;
      }
    });
    const intraGeo = new THREE.BufferGeometry();
    intraGeo.setAttribute("position", new THREE.BufferAttribute(intraPos, 3));
    intraGeo.setAttribute("aColor", new THREE.BufferAttribute(intraCol, 3));
    intraGeo.setAttribute("aAlpha", new THREE.BufferAttribute(intraAlpha, 1));
    const lineMat = new THREE.ShaderMaterial({
      vertexShader: LINE_VERTEX,
      fragmentShader: LINE_FRAGMENT,
      uniforms: { uFogDensity: { value: FOG_DENSITY } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const intraLines = new THREE.LineSegments(intraGeo, lineMat);
    scene.add(intraLines);

    // Bridge segments: gentle bezier arcs (sampled), warm color, brighter.
    const segsPerBridge = BRIDGE_ARC_SEGMENTS;
    const bridgeVertCount = drawnBridges.length * segsPerBridge * 2;
    const bridgePos = new Float32Array(bridgeVertCount * 3);
    const bridgeCol = new Float32Array(bridgeVertCount * 3);
    const bridgeBaseAlpha = new Float32Array(bridgeVertCount);
    const bridgeAlpha = new Float32Array(bridgeVertCount);
    const bridgeColor = new THREE.Color(BRIDGE_COLOR);
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const lift = new THREE.Vector3();
    drawnBridges.forEach((e, k) => {
      va.copy(pos[e.a]);
      vb.copy(pos[e.b]);
      mid.addVectors(va, vb).multiplyScalar(0.5);
      const len = va.distanceTo(vb);
      // Lift the arc away from the origin so bridges bow around the core.
      lift.copy(mid);
      if (lift.lengthSq() < 1e-6) lift.set(0, 1, 0);
      lift.normalize().multiplyScalar(len * BRIDGE_ARC_LIFT);
      const ctrl = mid.clone().add(lift);
      const curve = new THREE.QuadraticBezierCurve3(va.clone(), ctrl, vb.clone());
      const samples = curve.getPoints(segsPerBridge);
      const w = BRIDGE_ALPHA * (0.55 + 0.45 * (e.weight / maxWeight));
      for (let s = 0; s < segsPerBridge; s++) {
        for (const [slot, p] of [[0, samples[s]], [1, samples[s + 1]]] as const) {
          const v = (k * segsPerBridge + s) * 2 + slot;
          bridgePos[v * 3] = p.x;
          bridgePos[v * 3 + 1] = p.y;
          bridgePos[v * 3 + 2] = p.z;
          bridgeCol[v * 3] = bridgeColor.r;
          bridgeCol[v * 3 + 1] = bridgeColor.g;
          bridgeCol[v * 3 + 2] = bridgeColor.b;
          bridgeBaseAlpha[v] = w;
          bridgeAlpha[v] = w;
        }
      }
    });
    const bridgeGeo = new THREE.BufferGeometry();
    bridgeGeo.setAttribute("position", new THREE.BufferAttribute(bridgePos, 3));
    bridgeGeo.setAttribute("aColor", new THREE.BufferAttribute(bridgeCol, 3));
    bridgeGeo.setAttribute("aAlpha", new THREE.BufferAttribute(bridgeAlpha, 1));
    const bridgeLines = new THREE.LineSegments(bridgeGeo, lineMat);
    scene.add(bridgeLines);

    // -----------------------------------------------------------------------
    // Community identity: centroid labels (billboarded sprites) + soft halos.
    // -----------------------------------------------------------------------
    const commMembers = new Map<number, number[]>();
    placed.forEach((p, i) => {
      if (p.community === null) return;
      const arr = commMembers.get(p.community) ?? [];
      arr.push(i);
      commMembers.set(p.community, arr);
    });
    const centroids = new Map<number, { center: THREE.Vector3; extent: number }>();
    for (const [ci, members] of commMembers) {
      const center = new THREE.Vector3();
      for (const i of members) center.add(pos[i]);
      center.divideScalar(members.length);
      let rms = 0;
      for (const i of members) rms += center.distanceToSquared(pos[i]);
      rms = Math.sqrt(rms / members.length);
      centroids.set(ci, { center, extent: Math.max(rms, 2) });
    }
    const radialTex = makeRadialTexture();
    const haloSprites: THREE.Sprite[] = [];
    const labelSprites: { sprite: THREE.Sprite; center: THREE.Vector3 }[] = [];
    const labelTextures: THREE.CanvasTexture[] = [];
    const labelMats: THREE.SpriteMaterial[] = [];
    const haloMats: THREE.SpriteMaterial[] = [];
    for (const [ci, { center, extent }] of centroids) {
      const haloMat = new THREE.SpriteMaterial({
        map: radialTex,
        color: communityColor(ci),
        transparent: true,
        opacity: HALO_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const halo = new THREE.Sprite(haloMat);
      halo.position.copy(center);
      halo.scale.setScalar(extent * HALO_SCALE);
      scene.add(halo);
      haloSprites.push(halo);
      haloMats.push(haloMat);

      const text = commLabel.get(ci) ?? `community ${ci}`;
      const { tex, aspect } = makeLabelTexture(text);
      labelTextures.push(tex);
      const labelMat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: LABEL_MAX_OPACITY, depthWrite: false, depthTest: false });
      labelMats.push(labelMat);
      const label = new THREE.Sprite(labelMat);
      label.position.copy(center).add(new THREE.Vector3(0, extent * 1.15 + 1.5, 0));
      label.scale.set(LABEL_WORLD_HEIGHT * aspect, LABEL_WORLD_HEIGHT, 1);
      label.renderOrder = 10;
      scene.add(label);
      labelSprites.push({ sprite: label, center: center.clone() });
    }

    // -----------------------------------------------------------------------
    // Visual state: hover, selection (ego network), legend emphasis.
    // -----------------------------------------------------------------------
    let hoveredIndex = -1;
    let selectedSet: Set<number> | null = null; // ego network (root + neighbors)
    let selectedRoot = -1;
    let legendCommunity: number | null = null;
    let legendIsolate = false;

    const applyVisualState = () => {
      const hAttr = pointGeo.getAttribute("aHighlight") as THREE.BufferAttribute;
      const dAttr = pointGeo.getAttribute("aDim") as THREE.BufferAttribute;
      for (let i = 0; i < n; i++) {
        let hi = 0;
        let dim = 0;
        if (selectedSet) {
          if (i === selectedRoot) hi = 1;
          else if (selectedSet.has(i)) hi = 0.45;
          else dim = 1;
        } else if (legendCommunity !== null) {
          const member = placed[i].community === legendCommunity;
          if (!member) dim = legendIsolate ? 1 : LEGEND_HOVER_DIM;
        }
        if (i === hoveredIndex) hi = Math.max(hi, 1);
        highlights[i] = hi;
        dims[i] = dim;
      }
      hAttr.needsUpdate = true;
      dAttr.needsUpdate = true;

      // Edge alphas follow the same emphasis.
      const applyEdgeAlpha = (drawn: DrawnEdge[], base: Float32Array, out: Float32Array, attr: THREE.BufferAttribute, vertsPer: number) => {
        drawn.forEach((e, k) => {
          let factor = 1;
          if (selectedSet) {
            // The ego subgraph: both endpoints inside the selected set (the
            // root is a member of the set).
            const inEgo = selectedSet.has(e.a) && selectedSet.has(e.b);
            factor = inEgo ? EGO_EDGE_BOOST : EDGE_DIM_FACTOR;
          } else if (legendCommunity !== null) {
            const member = placed[e.a].community === legendCommunity && placed[e.b].community === legendCommunity;
            const touches = placed[e.a].community === legendCommunity || placed[e.b].community === legendCommunity;
            factor = member ? 1.4 : touches ? 0.7 : legendIsolate ? 0.08 : 0.35;
          }
          for (let s = 0; s < vertsPer; s++) out[k * vertsPer + s] = base[k * vertsPer + s] * factor;
        });
        attr.needsUpdate = true;
      };
      applyEdgeAlpha(drawnIntra, intraBaseAlpha, intraAlpha, intraGeo.getAttribute("aAlpha") as THREE.BufferAttribute, 2);
      applyEdgeAlpha(drawnBridges, bridgeBaseAlpha, bridgeAlpha, bridgeGeo.getAttribute("aAlpha") as THREE.BufferAttribute, segsPerBridge * 2);
    };

    // -----------------------------------------------------------------------
    // Camera easing (ease-in-out; instant when prefers-reduced-motion).
    // -----------------------------------------------------------------------
    let ease: { t0: number; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; fromPos: THREE.Vector3 | null; toPos: THREE.Vector3 | null } | null = null;
    const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const easeCameraTo = (target: THREE.Vector3, position: THREE.Vector3 | null) => {
      if (reducedMotion) {
        controls.target.copy(target);
        if (position) camera.position.copy(position);
        return;
      }
      ease = { t0: performance.now(), fromTarget: controls.target.clone(), toTarget: target.clone(), fromPos: position ? camera.position.clone() : null, toPos: position ? position.clone() : null };
    };

    // -----------------------------------------------------------------------
    // Idle auto-rotation: engages after inactivity, eases in, stops instantly
    // on interaction. Disabled entirely under prefers-reduced-motion.
    // -----------------------------------------------------------------------
    let lastInteraction = performance.now();
    controls.autoRotate = false;
    controls.autoRotateSpeed = 0;
    const noteInteraction = () => {
      lastInteraction = performance.now();
      controls.autoRotate = false; // stop instantly
      controls.autoRotateSpeed = 0;
    };
    controls.addEventListener("start", noteInteraction);

    // -----------------------------------------------------------------------
    // Picking: raycast against the points on animation frames only when the
    // pointer moved (throttled). At this corpus size a linear pass is cheap.
    // -----------------------------------------------------------------------
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: RAY_POINT_THRESHOLD };
    const pointer = new THREE.Vector2();
    let pointerDirty = false;
    let pointerClient = { x: 0, y: 0 };
    const onPointerMove = (ev: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      pointerClient = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      pointerDirty = true;
    };
    const doPick = () => {
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(points);
      const id = hits.length ? hits[0].index ?? -1 : -1;
      if (id !== hoveredIndex) {
        hoveredIndex = id;
        applyVisualState();
        if (id >= 0) {
          const p = placed[id];
          setHover({ label: p.label ?? "", community: p.community, influence: p.influence, x: pointerClient.x, y: pointerClient.y });
          renderer.domElement.style.cursor = "pointer";
        } else {
          setHover(null);
          renderer.domElement.style.cursor = "";
        }
      } else if (id >= 0) {
        setHover((h) => (h ? { ...h, x: pointerClient.x, y: pointerClient.y } : h));
      }
    };

    const selectIndex = (idx: number, expand: boolean) => {
      if (expand && selectedSet && selectedRoot >= 0) {
        // Shift-click (or expand control): grow the ego network by one hop.
        const grown = new Set(selectedSet);
        for (const m of selectedSet) for (const nb of adjacency.get(m) ?? []) grown.add(nb);
        selectedSet = grown;
      } else {
        selectedRoot = idx;
        selectedSet = new Set([idx, ...(adjacency.get(idx) ?? [])]);
      }
      legendCommunity = null;
      legendIsolate = false;
      applyVisualState();
      easeCameraTo(pos[selectedRoot], null);
      setSelected(placed[selectedRoot].refId);
      setIsolated(null);
    };
    const clearSelection = () => {
      selectedSet = null;
      selectedRoot = -1;
      applyVisualState();
      setSelected(null);
    };

    let downAt = { x: 0, y: 0 };
    const onPointerDown = (ev: PointerEvent) => {
      downAt = { x: ev.clientX, y: ev.clientY };
    };
    const onClick = (ev: MouseEvent) => {
      // Ignore drags (orbit), only treat true clicks as selection.
      if (Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 5) return;
      noteInteraction();
      if (hoveredIndex >= 0) selectIndex(hoveredIndex, ev.shiftKey);
      else clearSelection();
    };
    const onDblClick = () => {
      if (hoveredIndex >= 0 && placed[hoveredIndex].refId) onSelectRef.current(placed[hoveredIndex].refId!);
    };
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("click", onClick);
    renderer.domElement.addEventListener("dblclick", onDblClick);

    // -----------------------------------------------------------------------
    // Imperative API for React-side controls (toggles, legend, reset).
    // -----------------------------------------------------------------------
    const defaultTarget = new THREE.Vector3(0, 0, 0);
    const defaultPos = new THREE.Vector3(0, 0, CAMERA_START);
    apiRef.current = {
      setEdgeMode(edgesOn: boolean, onlyBridges: boolean) {
        intraLines.visible = edgesOn && !onlyBridges;
        bridgeLines.visible = edgesOn;
      },
      setSelection(refId: string | null, expand: boolean) {
        if (refId === null) {
          clearSelection();
          return;
        }
        const idx = indexByRef.get(refId);
        if (idx !== undefined) selectIndex(idx, expand);
      },
      setLegendEmphasis(community: number | null, isolate: boolean) {
        legendCommunity = community;
        legendIsolate = isolate;
        if (community !== null) {
          selectedSet = null;
          selectedRoot = -1;
          setSelected(null);
        }
        applyVisualState();
        if (community !== null && isolate) {
          const c = centroids.get(community);
          if (c) {
            const dir = camera.position.clone().sub(controls.target).normalize();
            easeCameraTo(c.center, c.center.clone().add(dir.multiplyScalar(Math.max(c.extent * COMMUNITY_FRAME_DISTANCE * 3, 30))));
          }
        }
      },
      resetView() {
        selectedSet = null;
        selectedRoot = -1;
        legendCommunity = null;
        legendIsolate = false;
        applyVisualState();
        setSelected(null);
        setIsolated(null);
        easeCameraTo(defaultTarget, defaultPos);
      },
    };

    // -----------------------------------------------------------------------
    // Animation loop. No per-frame allocations (temps reused above).
    // -----------------------------------------------------------------------
    let raf = 0;
    let disposed = false;
    const animate = () => {
      if (disposed) return;
      raf = requestAnimationFrame(animate);

      // Camera easing.
      if (ease) {
        const t = Math.min(1, (performance.now() - ease.t0) / CAMERA_EASE_MS);
        const k = easeInOut(t);
        controls.target.lerpVectors(ease.fromTarget, ease.toTarget, k);
        if (ease.fromPos && ease.toPos) camera.position.lerpVectors(ease.fromPos, ease.toPos, k);
        if (t >= 1) ease = null;
      }

      // Idle auto-rotation with soft ease-in.
      if (!reducedMotion) {
        const idle = performance.now() - lastInteraction > IDLE_ROTATE_DELAY_MS;
        if (idle) {
          controls.autoRotate = true;
          controls.autoRotateSpeed += (IDLE_ROTATE_SPEED - controls.autoRotateSpeed) * IDLE_ROTATE_EASE;
        }
      }

      // Throttled picking: at most one raycast per frame, only if moved.
      if (pointerDirty) {
        pointerDirty = false;
        doPick();
      }

      // Label opacity: recede with distance, fade out when the camera is deep
      // inside a cluster so labels never obscure the points.
      for (const { sprite, center } of labelSprites) {
        const dist = camera.position.distanceTo(center);
        const fade = Math.min(1, Math.max(0, (dist - LABEL_FADE_NEAR) / LABEL_FADE_RANGE));
        (sprite.material as THREE.SpriteMaterial).opacity = LABEL_MAX_OPACITY * fade;
      }

      controls.update();
      composer.render();
    };
    animate();

    // Dev-only frame-cost probe: measures the synchronous render cost of 60
    // frames so performance is measurable even when RAF is throttled (hidden
    // tabs). Not part of the production bundle's behavior.
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __measureWebGraph?: () => { msPerFrame: number; impliedFps: number } }).__measureWebGraph = () => {
        const gl = renderer.getContext();
        const px = new Uint8Array(4);
        const t0 = performance.now();
        for (let i = 0; i < 60; i++) {
          composer.render();
          // Force a GPU flush per frame so the measurement includes real GPU
          // time, not just command queueing.
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        }
        const ms = (performance.now() - t0) / 60;
        return { msPerFrame: Math.round(ms * 100) / 100, impliedFps: Math.round((1000 / ms) * 10) / 10 };
      };
    }

    // -----------------------------------------------------------------------
    // Resize (container-aware, includes composer + camera aspect).
    // -----------------------------------------------------------------------
    const resizeObserver = new ResizeObserver(() => {
      const w = mount.clientWidth || 800;
      camera.aspect = w / height;
      camera.updateProjectionMatrix();
      renderer.setSize(w, height);
      composer.setSize(w, height);
      bloom.setSize(w, height);
    });
    resizeObserver.observe(mount);

    // -----------------------------------------------------------------------
    // Disposal: everything created above is released; no leak on tab switches.
    // -----------------------------------------------------------------------
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("click", onClick);
      renderer.domElement.removeEventListener("dblclick", onDblClick);
      controls.removeEventListener("start", noteInteraction);
      controls.dispose();
      pointGeo.dispose();
      pointMat.dispose();
      starGeo.dispose();
      starMat.dispose();
      intraGeo.dispose();
      bridgeGeo.dispose();
      lineMat.dispose();
      for (const m of haloMats) m.dispose();
      for (const m of labelMats) m.dispose();
      for (const t of labelTextures) t.dispose();
      radialTex.dispose();
      bloom.dispose();
      composer.dispose();
      renderer.dispose();
      apiRef.current = null;
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
    // communities/commLabel change only with a new run payload (nodes change too).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, edges, commLabel]);

  // React-side controls call into the scene imperatively.
  useEffect(() => {
    apiRef.current?.setEdgeMode(showEdges, bridgesOnly);
  }, [showEdges, bridgesOnly]);

  const legendHover = (ci: number | null) => {
    if (isolated !== null) return; // isolation wins over hover emphasis
    apiRef.current?.setLegendEmphasis(ci, false);
  };
  const legendClick = (ci: number) => {
    if (isolated === ci) {
      setIsolated(null);
      apiRef.current?.setLegendEmphasis(null, false);
    } else {
      setIsolated(ci);
      apiRef.current?.setLegendEmphasis(ci, true);
    }
  };

  if (placed.length === 0) {
    return (
      <p className="py-10 text-center text-[13px] text-text-muted">
        No 3D coordinates in this build (t-SNE needs paper embeddings). Rebuild the web after embedding the corpus.
      </p>
    );
  }

  return (
    <div className="relative">
      <div ref={mountRef} className="relative w-full overflow-hidden rounded-lg" style={{ height: HEIGHT }}>
        {/* Vignette: DOM overlay, zero GPU cost in-scene. */}
        <div className="pointer-events-none absolute inset-0 z-10" style={{ background: "radial-gradient(ellipse at center, transparent 55%, rgba(4,6,8,0.55) 100%)" }} />
      </div>

      {hover && (
        <div className="pointer-events-none absolute z-20 max-w-sm rounded-lg border border-border bg-surface-raised px-3 py-2 text-[12px] text-text-primary shadow-sm" style={{ left: Math.min(hover.x + 12, (mountRef.current?.clientWidth ?? 600) - 220), top: hover.y + 12 }}>
        {hover.label}
          <span className="mt-0.5 block text-[11px] text-text-muted">
            {hover.community !== null ? commLabel.get(hover.community) ?? `community ${hover.community}` : "unassigned"} · influence {hover.influence}
          </span>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
          <input type="checkbox" checked={showEdges} onChange={(e) => setShowEdges(e.target.checked)} /> edges
        </label>
        <label className={`flex items-center gap-1.5 text-[12px] ${showEdges ? "text-text-secondary" : "text-text-muted"}`}>
          <input type="checkbox" checked={bridgesOnly} disabled={!showEdges} onChange={(e) => setBridgesOnly(e.target.checked)} /> bridges only
        </label>
        <button type="button" onClick={() => apiRef.current?.resetView()} className="rounded border border-border px-2 py-0.5 text-[12px] text-text-secondary transition-colors hover:border-accent/40 hover:text-accent">
          reset view
        </button>
        {selected && (
          <button type="button" onClick={() => apiRef.current?.setSelection(selected, true)} className="rounded border border-border px-2 py-0.5 text-[12px] text-text-secondary transition-colors hover:border-accent/40 hover:text-accent">
            expand network
          </button>
        )}
        {drawnEdgeCounts && (
          <span className="font-mono text-[11px] text-text-muted">
            {drawnEdgeCounts.intra} intra + {drawnEdgeCounts.bridge} bridge edges drawn
          </span>
        )}
      </div>

      {/* Interactive legend: hover highlights a community, click isolates it. */}
      <div className="mt-2 flex flex-wrap items-center gap-2" onMouseLeave={() => legendHover(null)}>
        {communities.map((c) => (
          <button
            key={c.index}
            type="button"
            onMouseEnter={() => legendHover(c.index)}
            onClick={() => legendClick(c.index)}
            className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${isolated === c.index ? "border-accent/60 text-text-primary" : "border-border text-text-secondary hover:border-accent/30"}`}
          >
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: `#${communityColor(c.index).toString(16).padStart(6, "0")}` }} />
            {c.label ?? `community ${c.index}`}
            <span className="text-text-muted">{c.size}</span>
          </button>
        ))}
      </div>

      <p className="mt-1.5 text-[11px] text-text-muted">
        drag to orbit, scroll to zoom, right-drag to pan · hover for a paper's title · click a paper to light its network (shift-click or "expand network" grows it one hop) · double-click to open the paper · click empty space to clear
      </p>
    </div>
  );
}
