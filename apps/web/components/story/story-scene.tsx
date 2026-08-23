"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { COLOR } from "@/lib/design-tokens";
import { BOTANY_DEFAULTS, type BotanyConfig } from "@/lib/botany-config";
import { generateTree, libraryToTreeParams, type LibraryBotanyInput } from "@/lib/botany";
import { CAMERA_KEYFRAMES, LOD_LOW_OVERRIDES, STORY } from "./story-config";

// ---------------------------------------------------------------------------
// THE STORY CANVAS: one persistent WebGL scene for the whole scroll. The
// forest is the real libraries as their real trees (botany generator,
// consumed not modified); bridges are the real cross-domain pairs. Scroll
// progress drives the camera through eased keyframes; nothing mounts or
// unmounts between scenes.
//
// Budgets: DPR capped, two-level LOD per tree (full near, reduced far),
// sway only near the camera, hidden-tab pause, and a frame-budget fallback
// that drops to render-on-scroll when the rolling frame cost exceeds the
// budget (logged).
// ---------------------------------------------------------------------------

export type StoryBridge = { aIndex: number; bIndex: number; linkCount: number };

export function StoryScene({
  inputs,
  bridges,
  progressRef,
  reducedMotion,
}: {
  inputs: LibraryBotanyInput[];
  bridges: StoryBridge[];
  // Normalized scroll progress, written by the page's rAF scroll hook.
  progressRef: MutableRefObject<number>;
  reducedMotion: boolean;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || inputs.length === 0) return;
    const width = mount.clientWidth || window.innerWidth;
    const height = mount.clientHeight || window.innerHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COLOR.paper);
    scene.fog = new THREE.FogExp2(new THREE.Color(COLOR.paper).getHex(), STORY.fogDensity);

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 120);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, STORY.dprCap));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, BOTANY_DEFAULTS.lightAmbient));
    const key = new THREE.DirectionalLight(0xfff4e0, BOTANY_DEFAULTS.lightKey);
    key.position.set(4, 7, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xeafff2, BOTANY_DEFAULTS.lightRim);
    rim.position.set(-2, 5, -6);
    scene.add(rim);

    const disposables: { dispose(): void }[] = [];
    const track = <T extends { dispose(): void }>(x: T): T => {
      disposables.push(x);
      return x;
    };

    // Ground: a wide soft disc for the whole forest.
    const groundGeo = track(new THREE.CircleGeometry(40, 56));
    const groundMat = track(new THREE.MeshStandardMaterial({ color: new THREE.Color(BOTANY_DEFAULTS.groundColor), roughness: 1 }));
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // Shared unit geometries.
    const branchGeo = track(new THREE.CylinderGeometry(0.85, 1, 1, 7));
    const leafGeo = track(new THREE.PlaneGeometry(1, 1));
    const fruitGeo = track(new THREE.SphereGeometry(1, 8, 6));
    const blossomGeo = track(new THREE.OctahedronGeometry(1, 0));
    const softTex = track(makeSoftTexture());

    const lowConfig: BotanyConfig = { ...BOTANY_DEFAULTS, ...LOD_LOW_OVERRIDES };
    const spacing = STORY.treeSpacing;
    const x0 = -((inputs.length - 1) * spacing) / 2;

    type TreeLOD = { group: THREE.Group; full: THREE.Group; low: THREE.Group; x: number; phase: number };
    const trees: TreeLOD[] = [];
    const dummy = new THREE.Object3D();

    const buildLevel = (input: LibraryBotanyInput, cfg: BotanyConfig): THREE.Group => {
      const params = libraryToTreeParams(input, cfg);
      const g = generateTree(params, cfg);
      const level = new THREE.Group();
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
      const barkMat = track(new THREE.MeshStandardMaterial({ color: new THREE.Color(cfg.branchColor), roughness: 0.9 }));
      const branchesMesh = new THREE.InstancedMesh(branchGeo, barkMat, Math.max(1, g.branches.length));
      setInstances(branchesMesh, g.branches);
      branchesMesh.count = g.branches.length;
      level.add(branchesMesh);

      const foliage = new THREE.Color(params.foliageColor);
      if (params.leafDesat > 0) foliage.lerp(new THREE.Color(cfg.branchColor), params.leafDesat);
      const leafMat = track(
        new THREE.MeshStandardMaterial({
          color: params.inLeaf ? foliage : new THREE.Color(cfg.budColor),
          roughness: 0.7,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.92,
          emissive: (params.inLeaf ? foliage : new THREE.Color(cfg.budColor)).clone().multiplyScalar(0.25),
        }),
      );
      const leavesMesh = new THREE.InstancedMesh(leafGeo, leafMat, Math.max(1, g.leaves.length));
      setInstances(leavesMesh, g.leaves);
      leavesMesh.count = g.leaves.length;
      level.add(leavesMesh);

      if (g.fruit.length > 0) {
        const fruitMat = track(new THREE.MeshStandardMaterial({ color: new THREE.Color(cfg.fruitColor), roughness: 0.4, emissive: new THREE.Color(cfg.fruitColor).multiplyScalar(0.2) }));
        const m = new THREE.InstancedMesh(fruitGeo, fruitMat, g.fruit.length);
        setInstances(m, g.fruit);
        level.add(m);
      }
      if (g.blossoms.length > 0) {
        const blossomMat = track(new THREE.MeshStandardMaterial({ color: new THREE.Color(cfg.blossomColor), roughness: 0.5, emissive: new THREE.Color(cfg.blossomColor).multiplyScalar(0.35) }));
        const m = new THREE.InstancedMesh(blossomGeo, blossomMat, g.blossoms.length);
        setInstances(m, g.blossoms);
        level.add(m);
      }
      for (const tip of g.glowTips) {
        const m = track(new THREE.SpriteMaterial({ map: softTex, color: new THREE.Color(cfg.glowColor), transparent: true, opacity: cfg.glowOpacity, blending: THREE.AdditiveBlending, depthWrite: false }));
        const sprite = new THREE.Sprite(m);
        sprite.position.set(...tip);
        sprite.scale.setScalar(0.5);
        level.add(sprite);
      }
      return level;
    };

    inputs.forEach((input, i) => {
      const x = x0 + i * spacing;
      const group = new THREE.Group();
      group.position.set(x, 0, 0);
      const full = buildLevel(input, BOTANY_DEFAULTS);
      const low = buildLevel(input, lowConfig);
      low.visible = false;
      group.add(full);
      group.add(low);
      scene.add(group);
      trees.push({ group, full, low, x, phase: (libraryToTreeParams(input, BOTANY_DEFAULTS).seed % 1000) / 1000 });
    });

    // BRIDGES: the real cross-domain pairs as vine arcs between canopies.
    for (const b of bridges) {
      const a = trees[b.aIndex];
      const c = trees[b.bIndex];
      if (!a || !c) continue;
      const ha = libraryToTreeParams(inputs[b.aIndex], BOTANY_DEFAULTS).heightScale;
      const hc = libraryToTreeParams(inputs[b.bIndex], BOTANY_DEFAULTS).heightScale;
      const p0 = new THREE.Vector3(a.x, ha * 0.75, 0);
      const p2 = new THREE.Vector3(c.x, hc * 0.75, 0);
      const mid = p0.clone().add(p2).multiplyScalar(0.5);
      mid.y += p0.distanceTo(p2) * BOTANY_DEFAULTS.bridgeArcHeight;
      const curve = new THREE.QuadraticBezierCurve3(p0, mid, p2);
      const radius = BOTANY_DEFAULTS.bridgeBaseRadius + BOTANY_DEFAULTS.bridgeRadiusPerLink * b.linkCount;
      const tubeGeo = track(new THREE.TubeGeometry(curve, 28, radius, 6, false));
      const tubeMat = track(
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(COLOR.green),
          emissive: new THREE.Color(COLOR.green).multiplyScalar(0.5),
          transparent: true,
          opacity: Math.min(0.9, BOTANY_DEFAULTS.bridgeOpacityBase + BOTANY_DEFAULTS.bridgeOpacityPerLink * b.linkCount),
          roughness: 0.6,
        }),
      );
      scene.add(new THREE.Mesh(tubeGeo, tubeMat));
    }

    // Camera along the eased keyframe path.
    const pos = new THREE.Vector3();
    const look = new THREE.Vector3();
    const currentLook = new THREE.Vector3(0, 1.6, 0);
    const applyCamera = (p: number, ease: number) => {
      const kfs = CAMERA_KEYFRAMES;
      let i = 0;
      while (i < kfs.length - 2 && p > kfs[i + 1].p) i++;
      const a = kfs[i];
      const b = kfs[i + 1];
      const t = Math.min(1, Math.max(0, (p - a.p) / Math.max(1e-6, b.p - a.p)));
      const s = t * t * (3 - 2 * t); // smoothstep between keyframes
      pos.set(
        a.pos[0] + (b.pos[0] - a.pos[0]) * s,
        a.pos[1] + (b.pos[1] - a.pos[1]) * s,
        a.pos[2] + (b.pos[2] - a.pos[2]) * s,
      );
      look.set(
        a.look[0] + (b.look[0] - a.look[0]) * s,
        a.look[1] + (b.look[1] - a.look[1]) * s,
        a.look[2] + (b.look[2] - a.look[2]) * s,
      );
      camera.position.lerp(pos, ease);
      currentLook.lerp(look, ease);
      camera.lookAt(currentLook);
    };

    // Static path (reduced motion): one readable overview frame, no loop.
    if (reducedMotion) {
      applyCamera(0.4, 1);
      trees.forEach((t) => {
        const d = camera.position.distanceTo(new THREE.Vector3(t.x, 1.2, 0));
        t.full.visible = d < STORY.lodNearDistance * 1.6;
        t.low.visible = !t.full.visible;
      });
      renderer.render(scene, camera);
    }

    let raf = 0;
    let disposed = false;
    let onDemand = false; // frame-budget fallback: render only on scroll change
    let lastRenderedProgress = -1;
    let costSum = 0;
    let costCount = 0;

    const renderFrame = () => {
      const t0 = performance.now();
      const p = Math.min(1, Math.max(0, progressRef.current));
      applyCamera(p, STORY.scrollEase);
      const now = performance.now() / 1000;
      for (const t of trees) {
        const d = camera.position.distanceTo(new THREE.Vector3(t.x, 1.2, 0));
        const near = d < STORY.lodNearDistance;
        t.full.visible = near;
        t.low.visible = !near;
        // Sway only near the camera (offscreen/distant trees skip the work).
        if (!STORY.swayNearOnly || near) {
          t.group.rotation.z = Math.sin(now * BOTANY_DEFAULTS.swaySpeed * Math.PI + t.phase * Math.PI * 2) * BOTANY_DEFAULTS.swayAmount;
        }
      }
      renderer.render(scene, camera);
      lastRenderedProgress = p;
      costSum += performance.now() - t0;
      costCount += 1;
      if (costCount >= 90) {
        const avg = costSum / costCount;
        costSum = 0;
        costCount = 0;
        if (avg > STORY.frameBudgetMs && !onDemand) {
          onDemand = true;
          console.warn(`[story] frame cost ${avg.toFixed(1)}ms exceeds ${STORY.frameBudgetMs}ms budget; degrading to render-on-scroll`);
        }
      }
    };

    const animate = () => {
      if (disposed) return;
      raf = requestAnimationFrame(animate);
      if (onDemand && Math.abs(progressRef.current - lastRenderedProgress) < 0.0005) return;
      renderFrame();
    };
    if (!reducedMotion) animate();

    const onVisibility = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else if (!disposed && !reducedMotion) animate();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onResize = () => {
      const w = mount.clientWidth || window.innerWidth;
      const h = mount.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      if (reducedMotion) renderer.render(scene, camera);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
      scene.traverse((obj) => {
        if (obj instanceof THREE.InstancedMesh) obj.dispose();
      });
      for (const d of disposables) d.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [inputs, bridges, progressRef, reducedMotion]);

  return <div ref={mountRef} aria-hidden="true" className="fixed inset-0 z-0" />;
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
