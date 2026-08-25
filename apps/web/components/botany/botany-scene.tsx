"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { COLOR } from "@/lib/design-tokens";
import type { BotanyConfig } from "@/lib/botany-config";
import type { TreeParams } from "@/lib/botany";
import { buildTreeVisual, captionFromParams, makeLightRig, makeMist, makeSharedGeos } from "./tree-builder";

// ---------------------------------------------------------------------------
// BOTANY SCENE (/botany-test): renders trees and bridges through the SHARED
// tree-visual builder (same materials and lighting as the narrative forest),
// with orbit controls, optional low bloom, fog, mist, contact shadows, and
// DOM name+state labels anchored to each tree. Everything tunable lives in
// BotanyConfig; the data mapping is untouched here.
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
  showLabels = true,
  onStats,
}: {
  trees: SceneTree[];
  bridges: SceneBridge[];
  config: BotanyConfig;
  heightPx?: number;
  showLabels?: boolean;
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
    scene.fog = new THREE.FogExp2(new THREE.Color(COLOR.paper).getHex(), config.fogDensity);

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

    const disposables: { dispose(): void }[] = [];
    const track = <T extends { dispose(): void }>(x: T): T => {
      disposables.push(x);
      return x;
    };

    // Optional subtle bloom, threshold-gated so only bright glow elements lift.
    let composer: EffectComposer | null = null;
    if (config.bloomStrength > 0) {
      composer = new EffectComposer(renderer);
      composer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP));
      composer.setSize(width, height);
      composer.addPass(new RenderPass(scene, camera));
      const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), config.bloomStrength, config.bloomRadius, config.bloomThreshold);
      track(bloom);
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
      track({ dispose: () => composer?.dispose() });
    }

    for (const light of makeLightRig(config)) scene.add(light);

    const groundGeo = track(new THREE.CircleGeometry(spread * 2.2, 48));
    const groundMat = track(new THREE.MeshStandardMaterial({ color: new THREE.Color(config.groundColor), roughness: 1, metalness: 0 }));
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    const shared = makeSharedGeos(config, track);
    const mist = makeMist(config, spread * 1.6, track, shared.softTex);
    if (mist) scene.add(mist);

    // DOM labels: name + honest state caption, projected to each tree's
    // canopy anchor per frame. Real text, selectable, screen-reader legible.
    const labelEls: { el: HTMLDivElement; world: THREE.Vector3 }[] = [];
    const labelLayer = document.createElement("div");
    labelLayer.className = "pointer-events-none absolute inset-0 overflow-hidden";
    if (showLabels) mount.appendChild(labelLayer);

    const treeGroups: THREE.Group[] = [];
    const treePhases: number[] = [];
    let statBranches = 0;
    let statLeaves = 0;
    let statVerts = 0;
    let statDraws = 0;

    trees.forEach((t) => {
      const built = buildTreeVisual(t.params, config, shared, track);
      built.group.position.set(t.x, 0, t.z);
      scene.add(built.group);
      treeGroups.push(built.group);
      treePhases.push((t.params.seed % 1000) / 1000);
      statBranches += built.stats.branchInstances;
      statLeaves += built.stats.leafInstances;
      statVerts += built.stats.effectiveVertices;
      statDraws += built.stats.drawCalls;

      if (showLabels) {
        const el = document.createElement("div");
        el.className = "absolute -translate-x-1/2 text-center";
        el.innerHTML = `<p class="font-display text-ui leading-tight text-ink">${t.params.libraryName}</p><p class="text-caption text-ink-500">${captionFromParams(t.params)}</p>`;
        labelLayer.appendChild(el);
        labelEls.push({ el, world: built.labelAnchor.clone().add(new THREE.Vector3(t.x, 0, t.z)) });
      }
    });

    for (const b of bridges) {
      const a = trees[b.fromIndex];
      const c = trees[b.toIndex];
      if (!a || !c) continue;
      const p0 = new THREE.Vector3(a.x, a.params.heightScale * 0.75, a.z);
      const p2 = new THREE.Vector3(c.x, c.params.heightScale * 0.75, c.z);
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

    onStatsRef.current?.({
      drawCallsPerTree: Math.round(statDraws / trees.length),
      branchInstances: Math.round(statBranches / trees.length),
      leafInstances: Math.round(statLeaves / trees.length),
      effectiveVertices: Math.round(statVerts / trees.length),
    });

    const proj = new THREE.Vector3();
    const updateLabels = () => {
      for (const l of labelEls) {
        proj.copy(l.world).project(camera);
        const sx = ((proj.x + 1) / 2) * (mount.clientWidth || width);
        const sy = ((1 - proj.y) / 2) * height;
        const visible = proj.z < 1 && sy > -40 && sy < height + 40;
        l.el.style.display = visible ? "" : "none";
        if (visible) l.el.style.transform = `translate(${sx}px, ${sy}px) translateX(-50%)`;
      }
    };

    let raf = 0;
    let disposed = false;
    const renderOnce = () => (composer ? composer.render() : renderer.render(scene, camera));
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
      }
      controls.update();
      updateLabels();
      renderOnce();
    };
    animate();

    const onResize = () => {
      const w = mount.clientWidth || 800;
      camera.aspect = w / height;
      camera.updateProjectionMatrix();
      renderer.setSize(w, height);
      composer?.setSize(w, height);
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
      if (labelLayer.parentNode === mount) mount.removeChild(labelLayer);
    };
  }, [trees, bridges, config, heightPx, showLabels]);

  return <div ref={mountRef} className="relative w-full overflow-hidden rounded-(--radius-glass)" style={{ height: heightPx }} />;
}
