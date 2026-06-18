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
  SynthesisTheme,
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

// Vertical plot region (leaves room for the bottom year axis and top controls).
const PAD_T = 52;
const PAD_B = 64;

// ---- tuning constants (centralized for a cheap fine-tuning pass) ----------
// Zoom thresholds (k = scale). FAR: structure only. MID: default labels.
// CLOSE: papers expand into claim sub-nodes.
const MID_MIN = 0.75;
const CLOSE_MIN = 1.8;

// Force layout. Charge (repulsion) and collision padding scale mildly with the
// node count so ~20 nodes spread without flying apart. forceX (date) is fixed;
// forceY is now retargeted by the selected Y mode (see targetY below).
const CHARGE_BASE = -260;
const CHARGE_PER_NODE = -16;
const CHARGE_MIN = -1200; // clamp (most negative) so the layout stays bounded
const COLLIDE_BASE = 22;
const COLLIDE_PER_NODE = 0.7;
const COLLIDE_MAX = 48;
// forceY bias toward the mode's target. Theme bands pull a bit harder so papers
// settle into their band; continuous axes are gentler so collision still
// separates them. Question nodes get a weak neutral pull.
const Y_STRENGTH_THEME = 0.32;
const Y_STRENGTH_CONTINUOUS = 0.18;
const Y_STRENGTH_QUESTION = 0.04;

// Claim expansion at CLOSE is viewport-culled: only papers within this many
// world units of the visible viewport expand into claim sub-nodes.
const CLAIM_VIEWPORT_MARGIN = 90;

// Label decluttering. At MID many labels overlap, so we greedily skip a label
// that would intersect an already-placed one (larger nodes win). Hovered or
// selected nodes always show a full, untruncated label.
const LABEL_VIEWPORT_MARGIN = 40;
const LABEL_CHAR_W = 5.6;
const LABEL_LINE_H = 13;
const LABEL_PAD = 3;
const LABEL_TRUNC_MID = 20;
const LABEL_TRUNC_CLOSE = 30;

// Open questions: nodes shown by default, edges hover/select-only; a toggle
// hides the question nodes entirely.
const SHOW_QUESTIONS_DEFAULT = true;

// Node size = influence (log of citation count), with a claim-count fallback
// for unmatched papers. Kept within a sane range so the graph stays legible.
const SIZE_MIN = 8;
const SIZE_MAX = 21;

// Theme color palette: a contained, deliberately MUTED and WARM categorical set
// (theme coloring needs multiple hues; these are desaturated and calm to fit
// the aesthetic, not bright/neon). Beyond the existing green/red/gray tokens.
const THEME_PALETTE = [
  "#b07a4f", // ochre
  "#6f8f6a", // sage
  "#a36a5b", // clay rose
  "#5f7f86", // dusty teal
  "#9c8a4e", // moss gold
  "#86697e", // muted plum
  "#7e8b5a", // olive
  "#b08968", // tan
  "#6b7f9c", // dusty blue
  "#9a6b66", // brick mauve
  "#5f8f7d", // muted green
  "#8a7a6b", // warm taupe
];
const UNTHEMED_COLOR = "var(--text-muted)";

type YMode = "theme" | "influence" | "centrality" | "semantic";
const Y_MODES: YMode[] = ["theme", "influence", "centrality", "semantic"];
const Y_MODE_DEFAULT: YMode = "theme";

type Level = "far" | "mid" | "close";
type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

type GNode = SimulationNodeDatum & {
  kind: "paper" | "question";
  id: string;
  label: string;
  r: number;
  targetX: number;
  xStrength: number;
  sizeFallback?: boolean; // true when size came from claim count (no citations)
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
function viewportBounds(
  t: { k: number; x: number; y: number },
  margin: number,
): Bounds {
  return {
    minX: (0 - t.x) / t.k - margin,
    maxX: (W - t.x) / t.k + margin,
    minY: (0 - t.y) / t.k - margin,
    maxY: (H - t.y) / t.k + margin,
  };
}
function inBounds(n: GNode, b: Bounds): boolean {
  return (
    n.x != null &&
    n.y != null &&
    n.x >= b.minX &&
    n.x <= b.maxX &&
    n.y >= b.minY &&
    n.y <= b.maxY
  );
}
// Map a normalized value (0..1) to a plot Y, higher value = higher on screen.
function valueToY(v: number): number {
  const top = PAD_T;
  const bot = H - PAD_B;
  return bot - v * (bot - top);
}

export function TimelineGraph({
  papers,
  edges,
  relations,
  openQuestions,
  themes,
  selected,
  onSelect,
}: {
  papers: SynthesisPaper[];
  edges: PaperEdge[];
  relations: SynthesisRelation[];
  openQuestions: SynthesisOpenQuestion[];
  themes: SynthesisTheme[];
  selected: GraphSelection | null;
  onSelect: (s: GraphSelection | null) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const nodesRef = useRef<GNode[]>([]);
  const linksRef = useRef<GLink[]>([]);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [, rerender] = useState(0);
  const [transform, setTransform] = useState({ k: 1, x: 0, y: 0 });
  const [showQuestions, setShowQuestions] = useState(SHOW_QUESTIONS_DEFAULT);
  const [hovered, setHovered] = useState<string | null>(null);
  const [yMode, setYMode] = useState<YMode>(Y_MODE_DEFAULT);
  const [showThemeLegend, setShowThemeLegend] = useState(false);

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

  // ---- axis derivations (client-side: theme, centrality; backend: influence,
  // semantic). Mode-independent maps; targetY picks one by mode. ------------
  const axes = useMemo(() => {
    const themeSize = new Map(themes.map((t) => [t.id, t.paperIds.length]));
    const themesByPaper = new Map<string, string[]>();
    for (const t of themes)
      for (const pid of t.paperIds) {
        const arr = themesByPaper.get(pid) ?? [];
        arr.push(t.id);
        themesByPaper.set(pid, arr);
      }
    // Primary theme = the paper's theme shared with the most other papers
    // (largest theme), ties broken by theme order (themes array order).
    const themeOrder = new Map(themes.map((t, i) => [t.id, i]));
    const primaryTheme = new Map<string, string | null>();
    for (const p of papers) {
      const mine = themesByPaper.get(p.id) ?? [];
      if (mine.length === 0) {
        primaryTheme.set(p.id, null);
        continue;
      }
      let best = mine[0];
      for (const tid of mine) {
        const a = themeSize.get(tid) ?? 0;
        const b = themeSize.get(best) ?? 0;
        if (a > b || (a === b && (themeOrder.get(tid) ?? 0) < (themeOrder.get(best) ?? 0)))
          best = tid;
      }
      primaryTheme.set(p.id, best);
    }

    // Bands: distinct primary themes in theme order, plus an "(unthemed)" band
    // if any paper lacks a theme.
    const usedThemeIds = themes
      .map((t) => t.id)
      .filter((id) => [...primaryTheme.values()].includes(id));
    const hasUnthemed = [...primaryTheme.values()].includes(null);
    const bandKeys: (string | null)[] = [...usedThemeIds];
    if (hasUnthemed) bandKeys.push(null);
    const nBands = Math.max(1, bandKeys.length);
    const bandY = new Map<string | null, number>();
    const colorOf = new Map<string | null, string>();
    const legend: { key: string | null; name: string; color: string; y: number }[] =
      [];
    bandKeys.forEach((key, k) => {
      const y = PAD_T + (k + 0.5) * ((H - PAD_B - PAD_T) / nBands);
      bandY.set(key, y);
      const color = key === null ? UNTHEMED_COLOR : THEME_PALETTE[k % THEME_PALETTE.length];
      colorOf.set(key, color);
      const name =
        key === null ? "(unthemed)" : (themes.find((t) => t.id === key)?.name ?? "theme");
      legend.push({ key, name, color, y });
    });

    const colorByPaper = new Map<string, string>();
    for (const p of papers)
      colorByPaper.set(p.id, colorOf.get(primaryTheme.get(p.id) ?? null) ?? UNTHEMED_COLOR);

    // Centrality = relation edges the paper participates in, normalized.
    const edgeCount = new Map<string, number>();
    for (const r of relations) {
      edgeCount.set(r.fromPaperId, (edgeCount.get(r.fromPaperId) ?? 0) + 1);
      edgeCount.set(r.toPaperId, (edgeCount.get(r.toPaperId) ?? 0) + 1);
    }
    const maxEdges = Math.max(1, ...[...edgeCount.values()]);

    // Influence = log(citedByCount + 1), normalized across the library.
    const logc = new Map<string, number>();
    for (const p of papers)
      if (p.citedByCount != null) logc.set(p.id, Math.log(p.citedByCount + 1));
    const maxLog = Math.max(0, ...[...logc.values()]);

    const themeYByPaper = new Map<string, number>();
    const influenceYByPaper = new Map<string, number>();
    const centralityYByPaper = new Map<string, number>();
    const semanticYByPaper = new Map<string, number>();
    for (const p of papers) {
      themeYByPaper.set(p.id, bandY.get(primaryTheme.get(p.id) ?? null) ?? H / 2);
      const inf = maxLog > 0 ? (logc.get(p.id) ?? 0) / maxLog : 0;
      influenceYByPaper.set(p.id, valueToY(inf));
      centralityYByPaper.set(p.id, valueToY((edgeCount.get(p.id) ?? 0) / maxEdges));
      semanticYByPaper.set(p.id, valueToY(p.semanticY ?? 0.5));
    }

    return {
      colorByPaper,
      legend,
      themeYByPaper,
      influenceYByPaper,
      centralityYByPaper,
      semanticYByPaper,
    };
  }, [papers, themes, relations]);

  // ---- build sim inputs (stable per dataset) ---------------------------
  const built = useMemo(() => {
    // Influence sizing: log citation, normalized; claim-count fallback.
    const logc = papers
      .filter((p) => p.citedByCount != null)
      .map((p) => Math.log((p.citedByCount as number) + 1));
    const maxLog = Math.max(0, ...logc);

    const paperX = new Map<string, number>();
    const paperNodes: GNode[] = papers.map((p) => {
      const ms = p.publishedAt ? new Date(p.publishedAt).getTime() : NaN;
      const tx = time && !Number.isNaN(ms) ? time.toX(ms) : UNDATED_X;
      paperX.set(p.id, tx);
      const sizeFallback = p.citedByCount == null || maxLog <= 0;
      const r = sizeFallback
        ? paperRadius(p.claimCount)
        : SIZE_MIN +
          (Math.log((p.citedByCount as number) + 1) / maxLog) *
            (SIZE_MAX - SIZE_MIN);
      return {
        kind: "paper",
        id: p.id,
        label: p.title,
        r,
        sizeFallback,
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
      const tx = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : W / 2;
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

    const nodeCount = built.nodes.length;
    const charge = Math.max(CHARGE_MIN, CHARGE_BASE + CHARGE_PER_NODE * nodeCount);
    const collidePad = Math.min(
      COLLIDE_MAX,
      COLLIDE_BASE + COLLIDE_PER_NODE * nodeCount,
    );

    // Y target for the current mode. Questions get a neutral center pull.
    const targetMap =
      yMode === "theme"
        ? axes.themeYByPaper
        : yMode === "influence"
          ? axes.influenceYByPaper
          : yMode === "centrality"
            ? axes.centralityYByPaper
            : axes.semanticYByPaper;
    const targetY = (d: GNode) =>
      d.kind === "question" ? H / 2 : (targetMap.get(d.id) ?? H / 2);
    const yStrength = (d: GNode) =>
      d.kind === "question"
        ? Y_STRENGTH_QUESTION
        : yMode === "theme"
          ? Y_STRENGTH_THEME
          : Y_STRENGTH_CONTINUOUS;

    const sim = forceSimulation(built.nodes)
      .force(
        "link",
        forceLink<GNode, GLink>(built.links)
          .id((d) => d.id)
          .distance((l) => (l.oq ? 70 : 110))
          .strength((l) => (l.oq ? 0.08 : 0.12)),
      )
      .force("charge", forceManyBody().strength(charge))
      .force("collide", forceCollide<GNode>().radius((d) => d.r + collidePad))
      .force(
        "x",
        forceX<GNode>((d) => d.targetX).strength((d) => d.xStrength),
      )
      .force("y", forceY<GNode>(targetY).strength(yStrength));

    if (reduce) {
      sim.stop();
      for (let i = 0; i < 300; i++) sim.tick();
      rerender((t) => t + 1);
    } else {
      sim.alpha(0.8).on("tick", () => rerender((t) => t + 1));
    }
    return () => {
      sim.stop();
    };
  }, [built, axes, yMode]);

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
    select(svgEl).call(zoomRef.current.transform, zoomIdentity);
  };

  const nodeById = useMemo(() => {
    const m = new Map<string, GNode>();
    for (const n of nodesRef.current) m.set(n.id, n);
    return m;
  }, [built, transform]);

  // Claim sub-node positions (ring around each settled paper). Built only at
  // CLOSE zoom AND only for in-viewport papers, bounding rendered claims.
  const claimPos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    if (level !== "close") return m;
    const vb = viewportBounds(transform, CLAIM_VIEWPORT_MARGIN);
    for (const p of papers) {
      const node = nodeById.get(p.id);
      if (!node || !inBounds(node, vb)) continue;
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
  }, [level, papers, nodeById, transform]);

  const focusedPaper =
    selected?.kind === "paper"
      ? selected.id
      : selected?.kind === "claim"
        ? selected.paperId
        : null;

  const activeOq =
    hovered && nodeById.get(hovered)?.kind === "question"
      ? hovered
      : selected?.kind === "question"
        ? selected.id
        : null;
  const oqRelated =
    activeOq != null
      ? new Set(nodeById.get(activeOq)?.relatedPaperIds ?? [])
      : null;

  // Greedy label collision avoidance, recomputed each render so it tracks live
  // sim positions. Candidates are in-viewport paper nodes; hovered/selected are
  // always labeled.
  const labeledPapers = (() => {
    const set = new Set<string>();
    if (level === "far") return set;
    const vb = viewportBounds(transform, LABEL_VIEWPORT_MARGIN);
    const trunc = level === "close" ? LABEL_TRUNC_CLOSE : LABEL_TRUNC_MID;
    type Box = { x0: number; y0: number; x1: number; y1: number };
    const placed: Box[] = [];
    const boxFor = (n: GNode): Box => {
      const w = Math.min(n.label.length, trunc) * LABEL_CHAR_W + LABEL_PAD * 2;
      const cx = n.x!;
      const top = n.y! + n.r + 4;
      return { x0: cx - w / 2, y0: top - LABEL_PAD, x1: cx + w / 2, y1: top + LABEL_LINE_H };
    };
    const overlaps = (a: Box, b: Box) =>
      a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
    const papersOnly = nodesRef.current.filter(
      (n) => n.kind === "paper" && n.x != null && n.y != null,
    );
    const forced = new Set<string>();
    if (focusedPaper) forced.add(focusedPaper);
    if (hovered && nodeById.get(hovered)?.kind === "paper") forced.add(hovered);
    const ordered = [
      ...papersOnly.filter((n) => forced.has(n.id)),
      ...papersOnly
        .filter((n) => !forced.has(n.id) && inBounds(n, vb))
        .sort((a, b) => b.r - a.r),
    ];
    for (const n of ordered) {
      const box = boxFor(n);
      if (forced.has(n.id) || !placed.some((p) => overlaps(p, box))) {
        set.add(n.id);
        placed.push(box);
      }
    }
    return set;
  })();

  // Y-axis guide values for continuous modes (faint gridlines + end labels).
  const continuousAxis: { topLabel: string; botLabel: string } | null =
    yMode === "influence"
      ? { topLabel: "more cited", botLabel: "less cited" }
      : yMode === "centrality"
        ? { topLabel: "more connected", botLabel: "less connected" }
        : yMode === "semantic"
          ? { topLabel: "semantic axis (latent)", botLabel: "" }
          : null;

  const controlBtn =
    "rounded px-2 py-0.5 text-[11px] transition-colors";

  return (
    <div className="relative">
      {/* Y-mode segmented control (top center) */}
      <div className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-1 text-[11px]">
        <span className="px-1 text-text-muted">Y</span>
        {Y_MODES.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setYMode(m)}
            className={`${controlBtn} ${
              yMode === m
                ? "bg-accent-dim font-medium text-accent"
                : "text-text-secondary hover:text-accent"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setShowQuestions((v) => !v)}
        className="absolute left-2 top-2 z-10 rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
      >
        {showQuestions ? "open questions: on" : "open questions: off"}
      </button>
      <button
        type="button"
        onClick={resetView}
        className="absolute right-2 top-2 z-10 rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
      >
        reset view
      </button>

      {/* Theme color legend (compact, collapsible, bottom-left) */}
      <div className="absolute bottom-2 left-2 z-10 max-w-[44%]">
        <button
          type="button"
          onClick={() => setShowThemeLegend((v) => !v)}
          className="rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
        >
          themes ({axes.legend.length}) {showThemeLegend ? "▾" : "▸"}
        </button>
        {showThemeLegend && (
          <div className="mt-1 max-h-[40%] space-y-1 overflow-y-auto rounded-md border border-border bg-surface p-2">
            {axes.legend.map((t) => (
              <div key={t.key ?? "unthemed"} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: t.color }}
                  aria-hidden
                />
                <span className="text-[11px] text-text-secondary">
                  {truncate(t.name, 34)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

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
          {/* time-axis vertical guide lines (year labels drawn in screen space) */}
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

          {/* Y guide lines: theme band lines, or continuous gridlines */}
          {yMode === "theme"
            ? axes.legend.map((b) => (
                <line
                  key={`band-${b.key ?? "unthemed"}`}
                  x1={0}
                  y1={b.y}
                  x2={W}
                  y2={b.y}
                  stroke="var(--border)"
                  strokeWidth={1 / transform.k}
                  strokeOpacity={0.6}
                />
              ))
            : [0.25, 0.5, 0.75].map((v) => (
                <line
                  key={`grid-${v}`}
                  x1={0}
                  y1={valueToY(v)}
                  x2={W}
                  y2={valueToY(v)}
                  stroke="var(--border)"
                  strokeWidth={1 / transform.k}
                  strokeOpacity={0.4}
                />
              ))}

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

          {/* open-question dashed edges: only for the hovered/selected question */}
          {showQuestions && activeOq && (
            <g style={{ opacity: 0.6 }}>
              {linksRef.current
                .filter((l) => l.oq && endpointId(l.source) === activeOq)
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
          )}

          {/* claim-level edges + sub-nodes (CLOSE only, viewport-culled) */}
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
                      stroke={isSel ? "var(--accent)" : "var(--border-strong)"}
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

            if (n.kind === "question") {
              if (!showQuestions) return null;
              const isSel =
                selected?.kind === "question" && selected.id === n.id;
              const isActive = activeOq === n.id;
              const showOqLabel = isActive || level === "close";
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  className="cursor-pointer"
                  opacity={level === "far" ? 0.5 : 1}
                  onMouseEnter={() => setHovered(n.id)}
                  onMouseLeave={() =>
                    setHovered((h) => (h === n.id ? null : h))
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(isSel ? null : { kind: "question", id: n.id });
                  }}
                >
                  <circle
                    r={n.r}
                    fill="none"
                    stroke={
                      isSel || isActive ? "var(--accent)" : "var(--text-muted)"
                    }
                    strokeWidth={1.5}
                    strokeDasharray="3 2.5"
                  />
                  {showOqLabel && (
                    <text
                      y={n.r + 11}
                      textAnchor="middle"
                      fontSize={9}
                      fill="var(--text-muted)"
                    >
                      ? {truncate(n.label, level === "close" ? 28 : 18)}
                    </text>
                  )}
                </g>
              );
            }

            const isSel = n.id === focusedPaper;
            const isHovered = hovered === n.id;
            const dim = focusedPaper != null && !isSel;
            const oqLinked = oqRelated?.has(n.id) ?? false;
            const showThisLabel = labeledPapers.has(n.id);
            const themeColor = axes.colorByPaper.get(n.id) ?? "var(--surface)";
            const labelText =
              isSel || isHovered
                ? n.label
                : truncate(
                    n.label,
                    level === "close" ? LABEL_TRUNC_CLOSE : LABEL_TRUNC_MID,
                  );
            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                className="cursor-pointer"
                opacity={dim && !oqLinked ? 0.3 : 1}
                onMouseEnter={() => setHovered(n.id)}
                onMouseLeave={() => setHovered((h) => (h === n.id ? null : h))}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(isSel ? null : { kind: "paper", id: n.id });
                }}
              >
                <circle
                  r={level === "far" ? Math.max(5, n.r - 3) : n.r}
                  fill={isSel ? "var(--accent-dim)" : themeColor}
                  fillOpacity={n.sizeFallback ? 0.4 : 0.9}
                  stroke={
                    isSel || oqLinked ? "var(--accent)" : "var(--border-strong)"
                  }
                  strokeWidth={isSel || oqLinked ? 2 : 1.5}
                />
                {showThisLabel && (
                  <text
                    y={n.r + 12}
                    textAnchor="middle"
                    fontSize={10}
                    fill={isSel ? "var(--accent)" : "var(--text-secondary)"}
                  >
                    {labelText}
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

        {/* Y-axis labels in SCREEN space (constant size). Theme: band names down
            the left. Continuous: top/bottom meaning of the axis. */}
        {yMode === "theme"
          ? axes.legend.map((b) => {
              const sy = b.y * transform.k + transform.y;
              if (sy < 14 || sy > H - 16) return null;
              return (
                <text
                  key={`ylab-${b.key ?? "unthemed"}`}
                  x={6}
                  y={sy + 3}
                  fontSize={10}
                  fill="var(--text-muted)"
                >
                  {truncate(b.name, 22)}
                </text>
              );
            })
          : continuousAxis && (
              <>
                <text
                  x={6}
                  y={Math.max(14, PAD_T * transform.k + transform.y)}
                  fontSize={10}
                  fill="var(--text-muted)"
                >
                  {continuousAxis.topLabel}
                </text>
                {continuousAxis.botLabel && (
                  <text
                    x={6}
                    y={Math.min(H - 18, (H - PAD_B) * transform.k + transform.y)}
                    fontSize={10}
                    fill="var(--text-muted)"
                  >
                    {continuousAxis.botLabel}
                  </text>
                )}
                {yMode === "semantic" && (
                  <text
                    x={6}
                    y={Math.max(26, PAD_T * transform.k + transform.y + 12)}
                    fontSize={9}
                    fill="var(--text-muted)"
                  >
                    latent dimension; nearby = similar
                  </text>
                )}
              </>
            )}
      </svg>
    </div>
  );
}
