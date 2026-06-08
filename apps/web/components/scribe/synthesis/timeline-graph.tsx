"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import type {
  SynthesisOpenQuestion,
  SynthesisPaper,
  SynthesisRelation,
} from "@/lib/types";
import {
  relationColor,
  type GraphSelection,
  type PaperEdge,
} from "@/lib/synthesis-graph";

const W = 920;
const H = 540;
const PAD_L = 70;
const UNDATED_X = W - 70;
const DATED_X_MAX = W - 170; // leave a band on the right for the undated lane

// Zoom thresholds (k = scale). FAR: structure only. MID: default. CLOSE:
// papers expand into claim sub-nodes.
const MID_MIN = 0.75;
const CLOSE_MIN = 1.8;

type Level = "far" | "mid" | "close";

type GNode = SimulationNodeDatum & {
  kind: "paper" | "question";
  id: string;
  label: string;
  r: number;
  targetX: number;
  xStrength: number;
  claims?: { id: string; text: string }[];
  relatedPaperIds?: string[];
};
type GLink = { source: string | GNode; target: string | GNode; oq: boolean };

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}
function paperRadius(claimCount: number): number {
  return Math.max(9, Math.min(15, 9 + claimCount * 0.6));
}
function endpointId(e: string | GNode): string {
  return typeof e === "string" ? e : e.id;
}

export function TimelineGraph({
  papers,
  edges,
  relations,
  openQuestions,
  selected,
  onSelect,
}: {
  papers: SynthesisPaper[];
  edges: PaperEdge[];
  relations: SynthesisRelation[];
  openQuestions: SynthesisOpenQuestion[];
  selected: GraphSelection | null;
  onSelect: (s: GraphSelection | null) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const nodesRef = useRef<GNode[]>([]);
  const linksRef = useRef<GLink[]>([]);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [, rerender] = useState(0);
  const [transform, setTransform] = useState({ k: 1, x: 0, y: 0 });

  const level: Level =
    transform.k >= CLOSE_MIN ? "close" : transform.k >= MID_MIN ? "mid" : "far";

  // ---- time scale -------------------------------------------------------
  const time = useMemo(() => {
    const dated = papers
      .map((p) => (p.publishedAt ? new Date(p.publishedAt).getTime() : NaN))
      .filter((t) => !Number.isNaN(t));
    if (dated.length === 0) return null;
    let min = Math.min(...dated);
    let max = Math.max(...dated);
    if (min === max) {
      min -= 1000 * 60 * 60 * 24 * 365;
      max += 1000 * 60 * 60 * 24 * 365;
    }
    const toX = (ms: number) =>
      PAD_L + ((ms - min) / (max - min)) * (DATED_X_MAX - PAD_L);
    const years: { year: number; x: number }[] = [];
    const y0 = new Date(min).getUTCFullYear();
    const y1 = new Date(max).getUTCFullYear();
    for (let y = y0; y <= y1; y++) {
      years.push({ year: y, x: toX(Date.UTC(y, 0, 1)) });
    }
    return { min, max, toX, years };
  }, [papers]);

  const hasUndated = useMemo(
    () => papers.some((p) => !p.publishedAt),
    [papers],
  );

  // ---- build sim inputs (stable per dataset) ---------------------------
  const built = useMemo(() => {
    const paperX = new Map<string, number>();
    const paperNodes: GNode[] = papers.map((p) => {
      const ms = p.publishedAt ? new Date(p.publishedAt).getTime() : NaN;
      const tx =
        time && !Number.isNaN(ms) ? time.toX(ms) : UNDATED_X;
      paperX.set(p.id, tx);
      return {
        kind: "paper",
        id: p.id,
        label: p.title,
        r: paperRadius(p.claimCount),
        targetX: tx,
        xStrength: Number.isNaN(ms) ? 0.35 : 0.6,
        claims: p.claims,
        x: tx,
        y: H / 2 + (Math.random() - 0.5) * 120,
      };
    });

    const qNodes: GNode[] = openQuestions.map((q, i) => {
      const xs = q.relatedPaperIds
        .map((pid) => paperX.get(pid))
        .filter((x): x is number => x != null);
      const tx = xs.length
        ? xs.reduce((a, b) => a + b, 0) / xs.length
        : W / 2;
      return {
        kind: "question",
        id: q.id,
        label: q.question,
        r: 7,
        targetX: tx,
        xStrength: 0.2,
        relatedPaperIds: q.relatedPaperIds,
        x: tx,
        y: H / 2 + (i % 2 === 0 ? -1 : 1) * (60 + i * 8),
      };
    });

    const nodes = [...paperNodes, ...qNodes];
    const links: GLink[] = [];
    for (const e of edges) links.push({ source: e.a, target: e.b, oq: false });
    for (const q of openQuestions)
      for (const pid of q.relatedPaperIds)
        links.push({ source: q.id, target: pid, oq: true });

    return { nodes, links };
  }, [papers, openQuestions, edges, time]);

  // ---- simulation ------------------------------------------------------
  useEffect(() => {
    nodesRef.current = built.nodes;
    linksRef.current = built.links;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const sim = forceSimulation(built.nodes)
      .force(
        "link",
        forceLink<GNode, GLink>(built.links)
          .id((d) => d.id)
          .distance((l) => (l.oq ? 70 : 110))
          .strength((l) => (l.oq ? 0.08 : 0.12)),
      )
      .force("charge", forceManyBody().strength(-300))
      .force("collide", forceCollide<GNode>().radius((d) => d.r + 24))
      .force(
        "x",
        forceX<GNode>((d) => d.targetX).strength((d) => d.xStrength),
      )
      .force("y", forceY(H / 2).strength(0.06));

    if (reduce) {
      sim.stop();
      for (let i = 0; i < 300; i++) sim.tick();
      rerender((t) => t + 1);
    } else {
      sim.on("tick", () => rerender((t) => t + 1));
    }
    return () => {
      sim.stop();
    };
  }, [built]);

  // ---- zoom + pan ------------------------------------------------------
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const zb = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.45, 4])
      .on("zoom", (e) =>
        setTransform({ k: e.transform.k, x: e.transform.x, y: e.transform.y }),
      );
    zoomRef.current = zb;
    select(svgEl).call(zb).on("dblclick.zoom", null);
    return () => {
      select(svgEl).on(".zoom", null);
    };
  }, []);

  const resetView = () => {
    const svgEl = svgRef.current;
    if (!svgEl || !zoomRef.current) return;
    // Apply identity instantly (avoids a d3-transition dependency); the
    // level-to-level fades are handled by CSS on the layers.
    select(svgEl).call(zoomRef.current.transform, zoomIdentity);
  };

  const nodeById = useMemo(() => {
    const m = new Map<string, GNode>();
    for (const n of nodesRef.current) m.set(n.id, n);
    return m;
  }, [built, transform]);

  // Claim sub-node positions (deterministic ring around each settled paper),
  // built only at CLOSE zoom for perf + clarity.
  const claimPos = useMemo(() => {
    if (level !== "close") return new Map<string, { x: number; y: number }>();
    const m = new Map<string, { x: number; y: number }>();
    for (const p of papers) {
      const node = nodeById.get(p.id);
      if (!node || node.x == null || node.y == null) continue;
      const n = p.claims.length;
      const ringR = node.r + 30;
      p.claims.forEach((c, i) => {
        const ang = (i / Math.max(1, n)) * 2 * Math.PI - Math.PI / 2;
        m.set(c.id, {
          x: node.x! + Math.cos(ang) * ringR,
          y: node.y! + Math.sin(ang) * ringR,
        });
      });
    }
    return m;
  }, [level, papers, nodeById]);

  const focusedPaper =
    selected?.kind === "paper"
      ? selected.id
      : selected?.kind === "claim"
        ? selected.paperId
        : null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={resetView}
        className="absolute right-2 top-2 z-10 rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
      >
        reset view
      </button>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full cursor-grab touch-none active:cursor-grabbing"
        role="img"
        aria-label="Synthesis timeline graph"
        onClick={() => onSelect(null)}
      >
        <g
          transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}
        >
          {/* time-axis vertical guide lines (labels are drawn in screen space) */}
          {time?.years.map((yr) => (
            <line
              key={yr.year}
              x1={yr.x}
              y1={0}
              x2={yr.x}
              y2={H}
              stroke="var(--border)"
              strokeWidth={1 / transform.k}
            />
          ))}
          {hasUndated && (
            <line
              x1={(DATED_X_MAX + UNDATED_X) / 2}
              y1={0}
              x2={(DATED_X_MAX + UNDATED_X) / 2}
              y2={H}
              stroke="var(--border)"
              strokeDasharray={`${4 / transform.k} ${4 / transform.k}`}
              strokeWidth={1 / transform.k}
            />
          )}

          {/* paper-level edges (fade as claim edges take over at CLOSE) */}
          <g
            style={{
              opacity: level === "close" ? 0.12 : 0.7,
              transition: "opacity 200ms ease",
            }}
          >
            {edges.map((e, i) => {
              const a = nodeById.get(e.a);
              const b = nodeById.get(e.b);
              if (!a || !b || a.x == null || b.x == null) return null;
              return (
                <line
                  key={i}
                  x1={a.x}
                  y1={a.y!}
                  x2={b.x}
                  y2={b.y!}
                  stroke={relationColor(e.dominantType)}
                  strokeWidth={e.dominantType === "contradicts" ? 2 : 1.5}
                />
              );
            })}
          </g>

          {/* open-question dashed edges */}
          <g style={{ opacity: level === "far" ? 0.25 : 0.5 }}>
            {linksRef.current
              .filter((l) => l.oq)
              .map((l, i) => {
                const a = nodeById.get(endpointId(l.source));
                const b = nodeById.get(endpointId(l.target));
                if (!a || !b || a.x == null || b.x == null) return null;
                return (
                  <line
                    key={`oq-${i}`}
                    x1={a.x}
                    y1={a.y!}
                    x2={b.x}
                    y2={b.y!}
                    stroke="var(--text-muted)"
                    strokeWidth={1 / Math.max(1, transform.k)}
                    strokeDasharray="3 3"
                  />
                );
              })}
          </g>

          {/* claim-level edges + sub-nodes (CLOSE only) */}
          {level === "close" && (
            <g style={{ transition: "opacity 200ms ease" }}>
              {relations.map((r) => {
                const f = claimPos.get(r.fromClaimId);
                const t = claimPos.get(r.toClaimId);
                if (!f || !t) return null;
                return (
                  <line
                    key={`cr-${r.id}`}
                    x1={f.x}
                    y1={f.y}
                    x2={t.x}
                    y2={t.y}
                    stroke={relationColor(r.relationType)}
                    strokeWidth={r.relationType === "contradicts" ? 1.6 : 1.2}
                    strokeOpacity={0.85}
                  />
                );
              })}
              {papers.flatMap((p) =>
                p.claims.map((c) => {
                  const pos = claimPos.get(c.id);
                  if (!pos) return null;
                  const isSel =
                    selected?.kind === "claim" && selected.id === c.id;
                  return (
                    <circle
                      key={`c-${c.id}`}
                      cx={pos.x}
                      cy={pos.y}
                      r={isSel ? 4.5 : 3.2}
                      fill={isSel ? "var(--accent)" : "var(--surface-raised)"}
                      stroke={
                        isSel ? "var(--accent)" : "var(--border-strong)"
                      }
                      strokeWidth={1}
                      className="cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(
                          isSel
                            ? null
                            : { kind: "claim", id: c.id, paperId: p.id },
                        );
                      }}
                    />
                  );
                }),
              )}
            </g>
          )}

          {/* nodes: papers + open questions */}
          {nodesRef.current.map((n) => {
            if (n.x == null || n.y == null) return null;
            const dim =
              focusedPaper != null &&
              n.kind === "paper" &&
              n.id !== focusedPaper;
            const showLabel = level !== "far";

            if (n.kind === "question") {
              const isSel =
                selected?.kind === "question" && selected.id === n.id;
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  className="cursor-pointer"
                  opacity={level === "far" ? 0.5 : 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(
                      isSel ? null : { kind: "question", id: n.id },
                    );
                  }}
                >
                  <circle
                    r={n.r}
                    fill="none"
                    stroke={isSel ? "var(--accent)" : "var(--text-muted)"}
                    strokeWidth={1.5}
                    strokeDasharray="3 2.5"
                  />
                  {level !== "far" && (
                    <text
                      y={n.r + 11}
                      textAnchor="middle"
                      fontSize={9}
                      fill="var(--text-muted)"
                    >
                      ?{" "}
                      {truncate(n.label, level === "close" ? 28 : 18)}
                    </text>
                  )}
                </g>
              );
            }

            const isSel = n.id === focusedPaper;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                className="cursor-pointer"
                opacity={dim ? 0.3 : 1}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(isSel ? null : { kind: "paper", id: n.id });
                }}
              >
                <circle
                  r={level === "far" ? Math.max(5, n.r - 3) : n.r}
                  fill={isSel ? "var(--accent-dim)" : "var(--surface)"}
                  stroke={isSel ? "var(--accent)" : "var(--border-strong)"}
                  strokeWidth={isSel ? 2 : 1.5}
                />
                {showLabel && (
                  <text
                    y={n.r + 12}
                    textAnchor="middle"
                    fontSize={10}
                    fill={isSel ? "var(--accent)" : "var(--text-secondary)"}
                  >
                    {truncate(n.label, level === "close" ? 30 : 20)}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* time-axis year labels in SCREEN space (constant size, pinned bottom) */}
        {time?.years.map((yr) => {
          const sx = yr.x * transform.k + transform.x;
          if (sx < 8 || sx > W - 8) return null;
          return (
            <text
              key={`yl-${yr.year}`}
              x={sx}
              y={H - 6}
              textAnchor="middle"
              fontSize={10}
              fill="var(--text-muted)"
            >
              {yr.year}
            </text>
          );
        })}
        {hasUndated && (
          <text
            x={((DATED_X_MAX + UNDATED_X) / 2) * transform.k + transform.x}
            y={H - 6}
            textAnchor="middle"
            fontSize={10}
            fill="var(--text-muted)"
          >
            undated
          </text>
        )}
      </svg>
    </div>
  );
}
