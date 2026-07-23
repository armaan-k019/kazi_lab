"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { WebCommunity, WebGraphEdge, WebGraphNode } from "@/lib/types";

// All tuning constants centralized here per the codebase convention.
const BG = 0x0b0d10;
const FOG_DENSITY = 0.012;
const LAYOUT_SCALE = 42; // scale t-SNE coords into the scene
const BASE_RADIUS = 0.6;
const MAX_RADIUS = 2.4;
const CAMERA_START = 90;
const COMMUNITY_COLORS = [0x6f9ceb, 0xc98a5e, 0x6fb08a, 0xb07ac0, 0xc96f6f, 0x8a95a8, 0xc0a24f, 0x5fb0b0, 0x9e7bd6, 0x66a3a3];
const EDGE_COLOR = 0x3a4048;
const BRIDGE_RING = 0xd98f6a;
const MAX_EDGES_DRAWN = 600; // draw only the highest-signal edges to avoid a hairball

function communityColor(c: number | null): number {
  return c === null || c < 0 ? 0x8a95a8 : COMMUNITY_COLORS[c % COMMUNITY_COLORS.length];
}

export function WebGraph3D({
  nodes,
  edges,
  communities,
  showEdges,
  onSelect,
}: {
  nodes: WebGraphNode[];
  edges: WebGraphEdge[];
  communities: WebCommunity[];
  showEdges: boolean;
  onSelect: (refId: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ label: string; community: number | null; x: number; y: number } | null>(null);
  // Keep a stable ref to the click handler so the animation setup does not
  // recapture stale props.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Only papers that have coordinates can be placed.
  const placed = useMemo(() => nodes.filter((n) => n.x !== null && n.y !== null && n.z !== null && n.refId), [nodes]);
  const commLabel = useMemo(() => new Map(communities.map((c) => [c.index, c.label])), [communities]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || placed.length === 0) return;
    const width = mount.clientWidth || 800;
    const height = 560;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);
    scene.fog = new THREE.FogExp2(BG, FOG_DENSITY);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 2000);
    camera.position.set(0, 0, CAMERA_START);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 0.5);
    dir.position.set(1, 1, 1);
    scene.add(dir);

    // Normalize coordinates to a centered cube.
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const n of placed) {
      minX = Math.min(minX, n.x!); maxX = Math.max(maxX, n.x!);
      minY = Math.min(minY, n.y!); maxY = Math.max(maxY, n.y!);
      minZ = Math.min(minZ, n.z!); maxZ = Math.max(maxZ, n.z!);
    }
    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    const pos = placed.map((n) => new THREE.Vector3(((n.x! - cx) / span) * LAYOUT_SCALE, ((n.y! - cy) / span) * LAYOUT_SCALE, ((n.z! - cz) / span) * LAYOUT_SCALE));

    const maxInfluence = Math.max(1, ...placed.map((n) => n.influence));
    const radiusOf = (n: WebGraphNode) => BASE_RADIUS + (MAX_RADIUS - BASE_RADIUS) * Math.sqrt(n.influence / maxInfluence);

    // Instanced spheres: one instance per paper, colored by community, sized by influence.
    const sphereGeo = new THREE.SphereGeometry(1, 12, 12);
    const sphereMat = new THREE.MeshLambertMaterial({ vertexColors: false });
    const mesh = new THREE.InstancedMesh(sphereGeo, sphereMat, placed.length);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    for (let i = 0; i < placed.length; i++) {
      dummy.position.copy(pos[i]);
      const r = radiusOf(placed[i]);
      dummy.scale.set(r, r, r);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.setHex(communityColor(placed[i].community)));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);

    // Bridge emphasis: a translucent glowing shell around bridge papers.
    const bridgeIdx = placed.map((n, i) => (n.isBridge ? i : -1)).filter((i) => i >= 0);
    if (bridgeIdx.length) {
      const ringGeo = new THREE.SphereGeometry(1, 14, 14);
      const ringMat = new THREE.MeshBasicMaterial({ color: BRIDGE_RING, transparent: true, opacity: 0.28, wireframe: true });
      const rings = new THREE.InstancedMesh(ringGeo, ringMat, bridgeIdx.length);
      bridgeIdx.forEach((idx, k) => {
        dummy.position.copy(pos[idx]);
        const r = radiusOf(placed[idx]) * 2.1;
        dummy.scale.set(r, r, r);
        dummy.updateMatrix();
        rings.setMatrixAt(k, dummy.matrix);
      });
      rings.instanceMatrix.needsUpdate = true;
      scene.add(rings);
    }

    // Edges: only the highest-signal ones, to avoid a hairball.
    let lines: THREE.LineSegments | null = null;
    if (showEdges) {
      const posByRef = new Map(placed.map((n, i) => [n.refId!, pos[i]]));
      const top = [...edges]
        .filter((e) => e.src && e.dst && posByRef.has(e.src) && posByRef.has(e.dst))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, MAX_EDGES_DRAWN);
      const verts: number[] = [];
      for (const e of top) {
        const a = posByRef.get(e.src!)!;
        const b = posByRef.get(e.dst!)!;
        verts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.35 }));
      scene.add(lines);
    }

    // Hover + click picking via raycasting against the instanced spheres.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hoveredInstance = -1;
    const onPointerMove = (ev: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(mesh)[0];
      const id = hit?.instanceId ?? -1;
      hoveredInstance = id;
      if (id >= 0) {
        const n = placed[id];
        setHover({ label: n.label ?? "", community: n.community, x: ev.clientX - rect.left, y: ev.clientY - rect.top });
      } else {
        setHover(null);
      }
    };
    const onClick = () => {
      if (hoveredInstance >= 0) {
        const n = placed[hoveredInstance];
        if (n.refId) onSelectRef.current(n.refId);
      }
    };
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("click", onClick);

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
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
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      sphereGeo.dispose();
      sphereMat.dispose();
      if (lines) {
        lines.geometry.dispose();
        (lines.material as THREE.Material).dispose();
      }
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [placed, edges, showEdges, commLabel]);

  if (placed.length === 0) {
    return (
      <p className="py-10 text-center text-[13px] text-text-muted">
        No 3D coordinates in this build (t-SNE needs paper embeddings). Rebuild the web after embedding the corpus.
      </p>
    );
  }

  return (
    <div className="relative">
      <div ref={mountRef} className="w-full overflow-hidden rounded-lg" style={{ height: 560 }} />
      {hover && (
        <div className="pointer-events-none absolute max-w-sm rounded-lg border border-border bg-surface-raised px-3 py-2 text-[12px] text-text-primary shadow-sm" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          {hover.label}
          <span className="mt-0.5 block text-[11px] text-text-muted">{hover.community !== null ? commLabel.get(hover.community) ?? `community ${hover.community}` : "unassigned"}</span>
        </div>
      )}
      <p className="mt-1 text-[11px] text-text-muted">drag to orbit, scroll to zoom, right-drag to pan; hover a point for its title, click to open the paper</p>
    </div>
  );
}
