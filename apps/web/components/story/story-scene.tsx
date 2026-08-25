"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { COLOR } from "@/lib/design-tokens";
import { BOTANY_DEFAULTS, type BotanyConfig } from "@/lib/botany-config";
import { libraryToTreeParams, type LibraryBotanyInput } from "@/lib/botany";
import { buildTreeVisual, captionFromParams, makeLightRig, makeMist, makeSharedGeos } from "@/components/botany/tree-builder";
import { CAMERA_KEYFRAMES, LOD_LOW_OVERRIDES, SCENES, STORY } from "./story-config";

// ---------------------------------------------------------------------------
// THE STORY CANVAS: one persistent WebGL scene for the whole scroll, now
// rendered through the SHARED tree-visual builder (same rich materials,
// lighting rig, contact shadows, mist, and optional bloom as /botany-test).
// Each tree carries a DOM name+state label anchored to its canopy; the vine
// arcs caption their real finding while the bridges chapter is active.
// LOD, sway-near-only, hidden-tab pause, and the frame-budget fallback all
// hold as before.
// ---------------------------------------------------------------------------

export type StoryBridge = { aIndex: number; bIndex: number; linkCount: number; summary: string };

export function StoryScene({
  inputs,
  bridges,
  progressRef,
  reducedMotion,
}: {
  inputs: LibraryBotanyInput[];
  bridges: StoryBridge[];
  progressRef: MutableRefObject<number>;
  reducedMotion: boolean;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || inputs.length === 0) return;
    const cfg: BotanyConfig = BOTANY_DEFAULTS;
    const width = mount.clientWidth || window.innerWidth;
    const height = mount.clientHeight || window.innerHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COLOR.paper);
    scene.fog = new THREE.FogExp2(new THREE.Color(COLOR.paper).getHex(), cfg.fogDensity);

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 120);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, STORY.dprCap));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    const disposables: { dispose(): void }[] = [];
    const track = <T extends { dispose(): void }>(x: T): T => {
      disposables.push(x);
      return x;
    };

    let composer: EffectComposer | null = null;
    if (cfg.bloomStrength > 0) {
      composer = new EffectComposer(renderer);
      composer.setPixelRatio(Math.min(window.devicePixelRatio, STORY.dprCap));
      composer.setSize(width, height);
      composer.addPass(new RenderPass(scene, camera));
      const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), cfg.bloomStrength, cfg.bloomRadius, cfg.bloomThreshold);
      track(bloom);
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
      track({ dispose: () => composer?.dispose() });
    }

    for (const light of makeLightRig(cfg)) scene.add(light);

    const groundGeo = track(new THREE.CircleGeometry(40, 56));
    const groundMat = track(new THREE.MeshStandardMaterial({ color: new THREE.Color(cfg.groundColor), roughness: 1 }));
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    const shared = makeSharedGeos(cfg, track);
    const mist = makeMist(cfg, 24, track, shared.softTex);
    if (mist) scene.add(mist);

    const lowConfig: BotanyConfig = { ...cfg, ...LOD_LOW_OVERRIDES };
    const spacing = STORY.treeSpacing;
    const x0 = -((inputs.length - 1) * spacing) / 2;

    // DOM overlay layer: tree labels and bridge captions, real text.
    const labelLayer = document.createElement("div");
    labelLayer.className = "pointer-events-none absolute inset-0 overflow-hidden";
    mount.appendChild(labelLayer);

    type TreeLOD = { group: THREE.Group; full: THREE.Group; low: THREE.Group; x: number; phase: number; labelEl: HTMLDivElement; labelWorld: THREE.Vector3 };
    const trees: TreeLOD[] = [];

    inputs.forEach((input, i) => {
      const x = x0 + i * spacing;
      const group = new THREE.Group();
      group.position.set(x, 0, 0);
      const paramsFull = libraryToTreeParams(input, cfg);
      const builtFull = buildTreeVisual(paramsFull, cfg, shared, track);
      const builtLow = buildTreeVisual(libraryToTreeParams(input, lowConfig), lowConfig, shared, track);
      builtLow.group.visible = false;
      group.add(builtFull.group);
      group.add(builtLow.group);
      scene.add(group);

      const el = document.createElement("div");
      el.className = "absolute -translate-x-1/2 text-center transition-opacity duration-300";
      el.innerHTML = `<p class="font-display text-lead leading-tight text-ink">${input.name}</p><p class="mt-0.5 text-small text-ink-500">${captionFromParams(paramsFull)}</p>`;
      labelLayer.appendChild(el);

      trees.push({
        group,
        full: builtFull.group,
        low: builtLow.group,
        x,
        phase: (paramsFull.seed % 1000) / 1000,
        labelEl: el,
        labelWorld: builtFull.labelAnchor.clone().add(new THREE.Vector3(x, 0, 0)),
      });
    });

    // BRIDGES: real cross-domain pairs as vine arcs, each with a DOM caption
    // naming its real finding, shown while the bridges chapter is active.
    const bridgeCaptionEls: { el: HTMLDivElement; world: THREE.Vector3 }[] = [];
    for (const b of bridges) {
      const a = trees[b.aIndex];
      const c = trees[b.bIndex];
      if (!a || !c) continue;
      const ha = libraryToTreeParams(inputs[b.aIndex], cfg).heightScale;
      const hc = libraryToTreeParams(inputs[b.bIndex], cfg).heightScale;
      const p0 = new THREE.Vector3(a.x, ha * 0.75, 0);
      const p2 = new THREE.Vector3(c.x, hc * 0.75, 0);
      const mid = p0.clone().add(p2).multiplyScalar(0.5);
      mid.y += p0.distanceTo(p2) * cfg.bridgeArcHeight;
      const curve = new THREE.QuadraticBezierCurve3(p0, mid, p2);
      const radius = cfg.bridgeBaseRadius + cfg.bridgeRadiusPerLink * b.linkCount;
      const tubeGeo = track(new THREE.TubeGeometry(curve, 28, radius, 6, false));
      const tubeMat = track(
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(COLOR.green),
          emissive: new THREE.Color(COLOR.green).multiplyScalar(0.5),
          transparent: true,
          opacity: Math.min(0.9, cfg.bridgeOpacityBase + cfg.bridgeOpacityPerLink * b.linkCount),
          roughness: 0.6,
        }),
      );
      scene.add(new THREE.Mesh(tubeGeo, tubeMat));

      const el = document.createElement("div");
      el.className = "absolute max-w-[240px] -translate-x-1/2 text-center transition-opacity duration-300";
      el.innerHTML = `<p class="text-caption leading-snug text-green-deep">${b.linkCount} link${b.linkCount === 1 ? "" : "s"}</p><p class="text-micro leading-snug text-ink-500">${b.summary.slice(0, 90)}</p>`;
      labelLayer.appendChild(el);
      bridgeCaptionEls.push({ el, world: mid.clone().add(new THREE.Vector3(0, 0.25, 0)) });
    }

    // The bridges chapter's progress range (captions show only there).
    const totalVh = SCENES.reduce((s, x) => s + x.lengthVh, 0);
    let acc = 0;
    let bridgesStart = 0;
    let bridgesEnd = 1;
    for (const s of SCENES) {
      const next = acc + s.lengthVh / totalVh;
      if (s.id === "bridges") {
        bridgesStart = acc;
        bridgesEnd = next;
      }
      acc = next;
    }

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
      const s = t * t * (3 - 2 * t);
      pos.set(a.pos[0] + (b.pos[0] - a.pos[0]) * s, a.pos[1] + (b.pos[1] - a.pos[1]) * s, a.pos[2] + (b.pos[2] - a.pos[2]) * s);
      look.set(a.look[0] + (b.look[0] - a.look[0]) * s, a.look[1] + (b.look[1] - a.look[1]) * s, a.look[2] + (b.look[2] - a.look[2]) * s);
      camera.position.lerp(pos, ease);
      currentLook.lerp(look, ease);
      camera.lookAt(currentLook);
    };

    const proj = new THREE.Vector3();
    const updateOverlays = (p: number) => {
      const w = mount.clientWidth || width;
      const h = mount.clientHeight || height;
      for (const t of trees) {
        proj.copy(t.labelWorld).project(camera);
        const d = camera.position.distanceTo(new THREE.Vector3(t.x, 1.2, 0));
        const visible = proj.z < 1 && d < STORY.lodNearDistance * 1.7;
        t.labelEl.style.opacity = visible ? "1" : "0";
        if (visible) t.labelEl.style.transform = `translate(${((proj.x + 1) / 2) * w}px, ${((1 - proj.y) / 2) * h}px) translateX(-50%)`;
      }
      const inBridges = p >= bridgesStart - 0.02 && p <= bridgesEnd + 0.02;
      for (const bc of bridgeCaptionEls) {
        proj.copy(bc.world).project(camera);
        const visible = inBridges && proj.z < 1;
        bc.el.style.opacity = visible ? "1" : "0";
        if (visible) bc.el.style.transform = `translate(${((proj.x + 1) / 2) * w}px, ${((1 - proj.y) / 2) * h}px) translateX(-50%)`;
      }
    };

    if (reducedMotion) {
      applyCamera(0.4, 1);
      trees.forEach((t) => {
        const d = camera.position.distanceTo(new THREE.Vector3(t.x, 1.2, 0));
        t.full.visible = d < STORY.lodNearDistance * 1.6;
        t.low.visible = !t.full.visible;
      });
      updateOverlays(0.4);
      if (composer) composer.render();
      else renderer.render(scene, camera);
    }

    let raf = 0;
    let disposed = false;
    let onDemand = false;
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
        if (!STORY.swayNearOnly || near) {
          t.group.rotation.z = Math.sin(now * cfg.swaySpeed * Math.PI + t.phase * Math.PI * 2) * cfg.swayAmount;
        }
      }
      updateOverlays(p);
      if (composer) composer.render();
      else renderer.render(scene, camera);
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
      composer?.setSize(w, h);
      if (reducedMotion) {
        if (composer) composer.render();
        else renderer.render(scene, camera);
      }
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
      if (labelLayer.parentNode === mount) mount.removeChild(labelLayer);
    };
  }, [inputs, bridges, progressRef, reducedMotion]);

  return <div ref={mountRef} aria-hidden="false" className="fixed inset-0 z-0" />;
}
