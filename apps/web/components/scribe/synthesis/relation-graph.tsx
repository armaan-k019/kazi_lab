"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from "d3-force";
import type { SynthesisPaper } from "@/lib/types";
import { RELATION_COLOR, type PaperEdge } from "@/lib/synthesis-graph";

const W = 820;
const H = 460;

type SimNode = SimulationNodeDatum & {
  id: string;
  title: string;
  claimCount: number;
  r: number;
};
type SimLink = {
  source: string | SimNode;
  target: string | SimNode;
  edge: PaperEdge;
};

function radius(claimCount: number): number {
  return Math.max(9, Math.min(16, 9 + claimCount * 0.7));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

function endpointId(e: string | SimNode): string {
  return typeof e === "string" ? e : e.id;
}

export function RelationGraph({
  papers,
  edges,
  selectedId,
  onSelect,
}: {
  papers: SynthesisPaper[];
  edges: PaperEdge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const [, forceRerender] = useState(0);

  // Build sim inputs once per dataset. papers/edges are memoized by the parent,
  // so identity changes only on a new fetch (library switch / new run).
  const built = useMemo(() => {
    const nodes: SimNode[] = papers.map((p, i) => ({
      id: p.id,
      title: p.title,
      claimCount: p.claimCount,
      r: radius(p.claimCount),
      // Seed positions on a ring so the layout settles tidily and reproducibly.
      x: W / 2 + Math.cos((i / Math.max(1, papers.length)) * 2 * Math.PI) * 140,
      y: H / 2 + Math.sin((i / Math.max(1, papers.length)) * 2 * Math.PI) * 140,
    }));
    const links: SimLink[] = edges.map((e) => ({
      source: e.a,
      target: e.b,
      edge: e,
    }));
    return { nodes, links };
  }, [papers, edges]);

  useEffect(() => {
    nodesRef.current = built.nodes;
    linksRef.current = built.links;
    const sim = forceSimulation(built.nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(built.links)
          .id((d) => d.id)
          .distance(180)
          .strength(0.25),
      )
      .force("charge", forceManyBody().strength(-560))
      .force("center", forceCenter(W / 2, H / 2))
      .force("collide", forceCollide<SimNode>().radius(60))
      .force("x", forceX(W / 2).strength(0.05))
      .force("y", forceY(H / 2).strength(0.07));
    sim.on("tick", () => forceRerender((t) => t + 1));
    return () => {
      sim.stop();
    };
  }, [built]);

  const connected = useMemo(() => {
    if (!selectedId) return null;
    const set = new Set<string>([selectedId]);
    for (const l of linksRef.current) {
      const a = endpointId(l.source);
      const b = endpointId(l.target);
      if (a === selectedId) set.add(b);
      if (b === selectedId) set.add(a);
    }
    return set;
  }, [selectedId, built]);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full select-none"
      role="img"
      aria-label="Paper relation graph"
      onClick={() => onSelect(null)}
    >
      {/* edges */}
      {linksRef.current.map((l, i) => {
        const s = l.source as SimNode;
        const t = l.target as SimNode;
        if (s.x == null || t.x == null) return null;
        const color = RELATION_COLOR[l.edge.dominantType];
        const dimmed =
          connected &&
          !(connected.has(s.id) && connected.has(t.id) && (s.id === selectedId || t.id === selectedId));
        return (
          <line
            key={i}
            x1={s.x}
            y1={s.y}
            x2={t.x}
            y2={t.y}
            stroke={color}
            strokeWidth={l.edge.dominantType === "contradicts" ? 2 : 1.5}
            strokeOpacity={dimmed ? 0.12 : 0.7}
          />
        );
      })}

      {/* nodes */}
      {nodesRef.current.map((n) => {
        if (n.x == null || n.y == null) return null;
        const isSelected = n.id === selectedId;
        const dimmed = connected && !connected.has(n.id);
        return (
          <g
            key={n.id}
            transform={`translate(${n.x},${n.y})`}
            className="cursor-pointer"
            opacity={dimmed ? 0.3 : 1}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(isSelected ? null : n.id);
            }}
          >
            <circle
              r={n.r}
              fill={isSelected ? "var(--accent-dim)" : "var(--surface)"}
              stroke={isSelected ? "var(--accent)" : "var(--border-strong)"}
              strokeWidth={isSelected ? 2 : 1.5}
            />
            <text
              y={n.r + 13}
              textAnchor="middle"
              fontSize={11}
              fill={isSelected ? "var(--accent)" : "var(--text-secondary)"}
            >
              {truncate(n.title, 22)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
