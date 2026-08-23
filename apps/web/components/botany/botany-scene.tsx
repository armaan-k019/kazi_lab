"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { COLOR } from "@/lib/design-tokens";
import type { BotanyConfig } from "@/lib/botany-config";
import { generateTree, type TreeParams } from "@/lib/botany";

// ---------------------------------------------------------------------------
// BOTANY SCENE: renders trees (and their bridges) from generated instance
// arrays. Instanced everything: one tree is 6 draw calls (branches, leaves,
// fruit, blossoms, glow, and a shared ground/motes pair per scene), so a
// 10-tree forest stays cheap. Gentle wind sway; reduced motion disables it.
// ---------------------------------------------------------------------------

const PIXEL_RATIO_CAP = 2;
const CAMERA_FOV = 40;

export type SceneTree = { params: TreeParams; x: number; z: number };
export type SceneBridge = { fromIndex: number; toIndex: number; linkCount: number };

export function BotanyScene({
  trees,
  bridges,
  config,
  heightPx = 560,
  onStats,
}: {
  trees: SceneTree[];
  bridges: SceneBridge[];
  config: BotanyConfig;
  heightPx?: number;
  onStats?: (s: { drawCallsPerTree: number; branchInstances: number; leafInstances: number; effectiveVertices: number }) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || trees.length === 0) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const width = mount.clientWidth || 800;
    const height = heightPx;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COLOR.paper);
    scene.fog = new THREE.FogExp2(new THREE.Color(COLOR.paper).getHex(), 0.045);

    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, width / height, 0.1, 100);
    const spread = Math.max(3.2, trees.length * 1.6);
    camera.position.set(0, 2.1, spread + 2.6);
    camera.lookAt(0, 1.2, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.target.set(0, 1.1, 0);

    // Soft key / fill / rim, consistent with the app's dark environment.
    scene.add(new THREE.AmbientLight(0xffffff, config.lightAmbient));
    const key = new THREE.DirectionalLight(0xfff4e0, config.lightKey);
    key.position.set(3, 5, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xd8e8ff, config.lightFill);
    fill.position.set(-3, 2, 2);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xeafff2, config.lightRim);
    rim.position.set(0, 4, -5);
    scene.add(rim);

    const disposables: { dispose(): void }[] = [];
    const track = <T extends { dispose(): void }>(x: T): T => {
      disposables.push(x);
      return x;
    };

    // Ground: a soft dark disc so trees sit somewhere.
    const groundGeo = track(new THREE.CircleGeometry(spread * 2.2, 48));
    const groundMat = track(new THREE.MeshStandardMaterial({ color: new THREE.Color(config.groundColor), roughness: 1, metalness: 0 }));
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // Shared unit geometries: instanced per tree.
    const branchGeo = track(new THREE.CylinderGeometry(0.85, 1, 1, 7));
    const leafGeo = track(new THREE.PlaneGeometry(1, 1));
    const fruitGeo = track(new THREE.SphereGeometry(1, 8, 6));
    const blossomGeo = track(new THREE.OctahedronGeometry(1, 0));
    const softTex = track(makeSoftTexture());

    const treeGroups: THREE.Group[] = [];
    const treePhases: number[] = [];
    let statBranches = 0;
    let statLeaves = 0;

    trees.forEach((t, ti) => {
      const g = generateTree(t.params, config);
      statBranches += g.branches.length;
      statLeaves += g.leaves.length;
      const group = new THREE.Group();
      group.position.set(t.x, 0, t.z);
      scene.add(group);
      treeGroups.push(group);
      treePhases.push((t.params.seed % 1000) / 1000);

      const dummy = new THREE.Object3D();
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

      const barkMat = track(new THREE.MeshStandardMaterial({ color: new THREE.Color(config.branchColor), roughness: 0.9, metalness: 0 }));
      const branchesMesh = new THREE.InstancedMesh(branchGeo, barkMat, Math.max(1, g.branches.length));
      setInstances(branchesMesh, g.branches);
      branchesMesh.count = g.branches.length;
      group.add(branchesMesh);

      // Foliage color: healthy = the derived community-harmonized hue;
      // critic-missing trees desaturate toward the bark register. Buds on
      // bare trees carry the bud color (life, not error).
      const foliage = new THREE.Color(t.params.foliageColor);
      if (t.params.leafDesat > 0) {
        const grey = new THREE.Color(config.branchColor);
        foliage.lerp(grey, t.params.leafDesat);
      }
      const leafMat = track(
        new THREE.MeshStandardMaterial({
          color: t.params.inLeaf ? foliage : new THREE.Color(config.budColor),
          roughness: 0.7,
          metalness: 0,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.92,
          emissive: t.params.inLeaf ? foliage.clone().multiplyScalar(0.25) : new THREE.Color(config.budColor).multiplyScalar(0.2),
        }),
      );
      const leavesMesh = new THREE.InstancedMesh(leafGeo, leafMat, Math.max(1, g.leaves.length));
      setInstances(leavesMesh, g.leaves);
      leavesMesh.count = g.leaves.length;
      group.add(leavesMesh);

      if (g.fruit.length > 0) {
        const fruitMat = track(new THREE.MeshStandardMaterial({ color: new THREE.Color(config.fruitColor), roughness: 0.4, emissive: new THREE.Color(config.fruitColor).multiplyScalar(0.2) }));
        const fruitMesh = new THREE.InstancedMesh(fruitGeo, fruitMat, g.fruit.length);
        setInstances(fruitMesh, g.fruit);
        group.add(fruitMesh);
      }
      if (g.blossoms.length > 0) {
        const blossomMat = track(new THREE.MeshStandardMaterial({ color: new THREE.Color(config.blossomColor), roughness: 0.5, emissive: new THREE.Color(config.blossomColor).multiplyScalar(0.35) }));
        const blossomMesh = new THREE.InstancedMesh(blossomGeo, blossomMat, g.blossoms.length);
        setInstances(blossomMesh, g.blossoms);
        group.add(blossomMesh);
      }
      for (const tip of g.glowTips) {
        const m = track(new THREE.SpriteMaterial({ map: softTex, color: new THREE.Color(config.glowColor), transparent: true, opacity: config.glowOpacity, blending: THREE.AdditiveBlending, depthWrite: false }));
        const sprite = new THREE.Sprite(m);
        sprite.position.set(...tip);
        sprite.scale.setScalar(0.5);
        group.add(sprite);
      }
    });

    // BRIDGES: cross-domain links as connecting growth. A vine arc between
    // canopies; thickness and brightness scale with the link count.
    for (const b of bridges) {
      const from = treeGroups[b.fromIndex];
      const to = treeGroups[b.toIndex];
      if (!from || !to) continue;
      const hFrom = trees[b.fromIndex].params.heightScale;
      const hTo = trees[b.toIndex].params.heightScale;
      const p0 = new THREE.Vector3(from.position.x, hFrom * 0.75, from.position.z);
      const p2 = new THREE.Vector3(to.position.x, hTo * 0.75, to.position.z);
      const mid = p0.clone().add(p2).multiplyScalar(0.5);
      mid.y += p0.distanceTo(p2) * config.bridgeArcHeight;
      const curve = new THREE.QuadraticBezierCurve3(p0, mid, p2);
      const radius = config.bridgeBaseRadius + config.bridgeRadiusPerLink * b.linkCount;
      const tubeGeo = track(new THREE.TubeGeometry(curve, 24, radius, 6, false));
      const tubeMat = track(
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(COLOR.green),
          emissive: new THREE.Color(COLOR.green).multiplyScalar(0.5),
          transparent: true,
          opacity: Math.min(0.9, config.bridgeOpacityBase + config.bridgeOpacityPerLink * b.linkCount),
          roughness: 0.6,
        }),
      );
      scene.add(new THREE.Mesh(tubeGeo, tubeMat));
    }

    // Motes: a few soft drifting particles for life.
    const moteRng = () => Math.random(); // decorative only, explicitly NOT data
    const motePositions = new Float32Array(config.motesCount * 3);
    for (let i = 0; i < config.motesCount; i++) {
      motePositions[i * 3] = (moteRng() * 2 - 1) * spread;
      motePositions[i * 3 + 1] = 0.3 + moteRng() * 2.4;
      motePositions[i * 3 + 2] = (moteRng() * 2 - 1) * spread;
    }
    const moteGeo = track(new THREE.BufferGeometry());
    moteGeo.setAttribute("position", new THREE.BufferAttribute(motePositions, 3));
    const moteMat = track(new THREE.PointsMaterial({ color: new THREE.Color(COLOR.green), size: 0.03, transparent: true, opacity: config.motesOpacity, depthWrite: false, blending: THREE.AdditiveBlending }));
    const motes = new THREE.Points(moteGeo, moteMat);
    scene.add(motes);

    // Report the real budget upward.
    const drawCallsPerTree = 4 + 1; // branches, leaves, fruit, blossoms (+ glow sprites vary); ground/motes shared
    onStatsRef.current?.({
      drawCallsPerTree,
      branchInstances: Math.round(statBranches / trees.length),
      leafInstances: Math.round(statLeaves / trees.length),
      effectiveVertices: Math.round((statBranches * 42 + statLeaves * 4) / trees.length),
    });

    let raf = 0;
    let disposed = false;
    const animate = () => {
      if (disposed) return;
      raf = requestAnimationFrame(animate);
      const t = performance.now() / 1000;
      if (!reducedMotion) {
        treeGroups.forEach((g, i) => {
          const phase = treePhases[i] * Math.PI * 2;
          g.rotation.z = Math.sin(t * config.swaySpeed * Math.PI * 2 * 0.5 + phase) * config.swayAmount;
          g.rotation.x = Math.cos(t * config.swaySpeed * Math.PI * 2 * 0.35 + phase) * config.swayAmount * 0.6;
        });
        motes.rotation.y = t * 0.02;
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      const w = mount.clientWidth || 800;
      camera.aspect = w / height;
      camera.updateProjectionMatrix();
      renderer.setSize(w, height);
    };
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(mount);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      controls.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.InstancedMesh) obj.dispose();
      });
      for (const d of disposables) d.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [trees, bridges, config, heightPx]);

  return <div ref={mountRef} className="w-full overflow-hidden rounded-(--radius-glass)" style={{ height: heightPx }} />;
}

function makeSoftTexture(): THREE.CanvasTexture {
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
