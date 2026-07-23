"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity } from "d3-zoom";
import type { WebAbcCandidate, WebDiscovery, WebLatest } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";

// A calm categorical palette for communities (functional color, restrained).
const COMMUNITY_COLORS = ["#6f9ceb", "#c98a5e", "#6fb08a", "#b07ac0", "#c96f6f", "#8a95a8", "#c0a24f", "#5fb0b0"];
const communityColor = (c: number | null) => (c === null || c < 0 ? "#8a95a8" : COMMUNITY_COLORS[c % COMMUNITY_COLORS.length]);

type GNode = SimulationNodeDatum & { id: string; label: string; community: number | null; degree: number; isBridge: boolean };
type GLink = SimulationLinkDatum<GNode> & { weight: number };

const W = 900;
const H = 560;

function verdictColor(v: string | null): string {
  if (v === "confirmed" || v === "promoted") return "var(--accent)";
  if (v === "demoted") return "#b07a4f";
  if (v === "rejected") return "#b4493b";
  return "var(--text-muted)";
}

export function WebView() {
  const [data, setData] = useState<WebLatest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [proposing, setProposing] = useState(false);

  const load = useCallback(() => {
    setError(null);
    fetch("/api/web/latest")
      .then((r) => r.json())
      .then((b: WebLatest) => setData(b))
      .catch(() => setError("Could not load the research web."));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const rebuild = async () => {
    if (building) return;
    setBuilding(true);
    setError(null);
    try {
      const res = await fetch("/api/web/build", { method: "POST" });
      const b = await res.json();
      if (!res.ok) throw new Error(b.error ?? "The web build could not complete.");
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBuilding(false);
    }
  };
  const propose = async () => {
    if (proposing) return;
    setProposing(true);
    setError(null);
    try {
      const res = await fetch("/api/web/propose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const b = await res.json();
      if (!res.ok) throw new Error(b.error ?? "The proposal run could not complete.");
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProposing(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: "easeOut" }}>
      <h2 className="text-2xl font-semibold tracking-tight text-text-primary">Research Web</h2>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-text-muted">
        The corpus as one knowledge graph, the lab&rsquo;s primary substrate (libraries are optional
        lenses now). Papers cluster into emergent communities by seeded Louvain; bridge analytics and
        Swanson ABC discovery surface cross-domain hypotheses, which enter the existing cross-domain
        Critic as candidates. The machine computes and grounds; it never asserts.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={rebuild} disabled={building || proposing} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50">
          {building ? "Rebuilding…" : "Rebuild web"}
        </button>
        <button type="button" onClick={propose} disabled={building || proposing || !data?.run} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-default disabled:opacity-50">
          {proposing ? "Proposing…" : "Propose crossovers"}
        </button>
        {(building || proposing) && <span className="flex items-center gap-2 text-[13px] text-text-secondary"><Spinner /> this takes a minute…</span>}
        {data?.run?.completedAt && !building && !proposing && <span className="text-[13px] text-text-muted">built {formatRelativeTime(data.run.completedAt)}</span>}
      </div>

      {error && <p className="mt-4 text-[13px] text-[#b4493b]">{error}</p>}

      {data && !data.run && (
        <p className="mt-8 max-w-md text-[15px] leading-relaxed text-text-muted">No web built yet. Rebuild the web to weave the corpus into a graph.</p>
      )}

      {data?.run && (
        <>
          <SanityStats data={data} />
          <div className="mt-6 rounded-xl border border-border bg-surface p-3">
            <WebGraph data={data} />
          </div>
          <DiscoveriesPanel abc={data.abc} discoveries={data.discoveries} />
        </>
      )}
    </motion.div>
  );
}

function SanityStats({ data }: { data: WebLatest }) {
  const s = data.run!.stats;
  const ari = s.ari;
  const orphan = s.orphanReport;
  return (
    <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Stat label="Nodes">
        {s.nodes ? `${s.nodes.papers} papers, ${s.nodes.claims} claims, ${s.nodes.methods} methods, ${s.nodes.datasets} datasets, ${s.nodes.concepts} concepts (${s.nodes.conceptMerges} merges)` : "-"}
      </Stat>
      <Stat label="Edges">
        {s.edges ? Object.entries(s.edges).map(([k, v]) => `${k} ${v}`).join(", ") : "-"}
        {typeof s.citations === "number" ? ` · citations ${s.citations}` : ""}
      </Stat>
      <Stat label="Emergent vs declared (ARI)">
        {ari ? `${ari.vsLibrariesAll} all, ${ari.vsLibrariesOnTopic ?? "n/a"} on-topic` : "-"}
        <span className="mt-1 block text-[11px] text-text-muted">Adjusted Rand index: emergent communities vs declared libraries. Higher = the graph rediscovered the domains.</span>
      </Stat>
      <Stat label="Orphan report">
        {orphan ? `${orphan.tinyCommunities.length} tiny communities, ${orphan.lowDegreePapers.length} low-degree papers` : "-"}
        {orphan && orphan.tinyCommunities.length === 0 && orphan.lowDegreePapers.length === 0 && (
          <span className="mt-1 block text-[11px] text-text-muted">Nothing isolated: the projection is dense (generic shared concepts connect broadly). Off-topic papers surface as high-betweenness bridges instead.</span>
        )}
      </Stat>
      <Stat label="Communities">
        {data.communities.map((c) => `[${c.index}] ${c.label ?? "?"} (${c.size})`).join(" · ")}
      </Stat>
      <Stat label="Discoveries">
        {data.discoveries.length > 0 ? `${data.discoveries.length} web-discovery proposal(s), audited by the cross-domain Critic` : "no proposals yet (run Propose crossovers)"}
      </Stat>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{label}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-text-primary">{children}</p>
    </div>
  );
}

function WebGraph({ data }: { data: WebLatest }) {
  const [rerender, setRerender] = useState(0);
  const [transform, setTransform] = useState({ k: 1, x: 0, y: 0 });
  const [hovered, setHovered] = useState<GNode | null>(null);
  const nodesRef = useRef<GNode[]>([]);
  const linksRef = useRef<GLink[]>([]);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const built = useMemo(() => {
    const nodes: GNode[] = data.nodes
      .filter((n) => n.refId)
      .map((n) => ({ id: n.refId!, label: n.label ?? "", community: n.community, degree: n.degree ?? 0, isBridge: n.isBridge }));
    const idset = new Set(nodes.map((n) => n.id));
    const links: GLink[] = data.edges
      .filter((e) => e.src && e.dst && idset.has(e.src) && idset.has(e.dst))
      .map((e) => ({ source: e.src!, target: e.dst!, weight: e.weight }));
    return { nodes, links };
  }, [data]);

  useEffect(() => {
    const nodes = built.nodes.map((n) => ({ ...n }));
    const links = built.links.map((l) => ({ ...l }));
    nodesRef.current = nodes;
    linksRef.current = links;
    // Seed positions by community so the layout converges quickly and cleanly.
    const communities = [...new Set(nodes.map((n) => n.community ?? -1))];
    const centers = new Map(communities.map((c, i) => {
      const angle = (i / Math.max(1, communities.length)) * Math.PI * 2;
      return [c, { x: W / 2 + Math.cos(angle) * 200, y: H / 2 + Math.sin(angle) * 150 }];
    }));
    for (const n of nodes) {
      const c = centers.get(n.community ?? -1)!;
      n.x = c.x + (Math.random() - 0.5) * 40;
      n.y = c.y + (Math.random() - 0.5) * 40;
    }
    const sim = forceSimulation(nodes)
      .force("link", forceLink<GNode, GLink>(links).id((d) => d.id).distance(50).strength((l) => Math.min(0.6, l.weight)))
      .force("charge", forceManyBody().strength(-70))
      .force("x", forceX<GNode>((n) => centers.get(n.community ?? -1)!.x).strength(0.12))
      .force("y", forceY<GNode>((n) => centers.get(n.community ?? -1)!.y).strength(0.12))
      .force("collide", forceCollide<GNode>(9))
      .alpha(0.9)
      .on("tick", () => setRerender((x) => x + 1));
    return () => {
      sim.stop();
    };
  }, [built]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const zb = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 4])
      .on("zoom", (e) => setTransform({ k: e.transform.k, x: e.transform.x, y: e.transform.y }));
    select(el).call(zb).on("dblclick.zoom", null);
    return () => {
      select(el).on(".zoom", null);
    };
  }, []);

  const maxDeg = Math.max(1, ...built.nodes.map((n) => n.degree));
  void rerender;

  return (
    <div className="relative">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H, cursor: "grab" }}>
        <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
          {linksRef.current.map((l, i) => {
            const s = l.source as GNode;
            const t = l.target as GNode;
            if (typeof s !== "object" || typeof t !== "object") return null;
            return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke="var(--border)" strokeOpacity={0.25} strokeWidth={0.5} />;
          })}
          {nodesRef.current.map((n) => {
            const dim = n.degree <= 1;
            const r = n.isBridge ? 7 : 4 + Math.round((n.degree / maxDeg) * 3);
            return (
              <g key={n.id} transform={`translate(${n.x} ${n.y})`} onMouseEnter={() => setHovered(n)} onMouseLeave={() => setHovered(null)} style={{ cursor: "pointer" }}>
                {n.isBridge && <circle r={r + 3} fill="none" stroke="#c96f6f" strokeWidth={1.5} strokeOpacity={0.9} />}
                <circle r={r} fill={communityColor(n.community)} fillOpacity={dim ? 0.35 : 0.9} stroke="var(--surface)" strokeWidth={0.6} />
              </g>
            );
          })}
        </g>
      </svg>

      {/* Legend */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {data.communities.map((c) => (
          <span key={c.index} className="flex items-center gap-1.5 text-[11px] text-text-secondary">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: communityColor(c.index) }} />
            {c.label ?? `community ${c.index}`} ({c.size})
          </span>
        ))}
        <span className="flex items-center gap-1.5 text-[11px] text-text-muted">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: "#c96f6f" }} /> bridge paper
        </span>
      </div>

      {hovered && (
        <div className="pointer-events-none absolute left-3 top-3 max-w-md rounded-lg border border-border bg-surface-raised px-3 py-2 text-[12px] text-text-primary shadow-sm">
          {hovered.label}
          <span className="mt-0.5 block text-[11px] text-text-muted">degree {hovered.degree}{hovered.isBridge ? " · bridge" : ""}</span>
        </div>
      )}
    </div>
  );
}

function DiscoveriesPanel({ abc, discoveries }: { abc: WebAbcCandidate[]; discoveries: WebDiscovery[] }) {
  return (
    <div className="mt-8">
      <h3 className="text-[13px] font-semibold uppercase tracking-wide text-text-secondary">Discoveries</h3>

      {discoveries.length > 0 && (
        <section className="mt-3">
          <p className="text-[12px] font-medium text-text-secondary">Crossover proposals (audited by the cross-domain Critic)</p>
          <div className="mt-2 space-y-3">
            {discoveries.map((d) => (
              <div key={d.id} className="rounded-xl border border-border bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ color: "#b07a4f", backgroundColor: "var(--surface-raised)" }}>
                    {d.verdict ? `critic: ${d.verdict}` : "candidate · needs pressure-testing"}
                  </span>
                  <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-secondary">{d.level}</span>
                  {d.verdict && <span className="text-[11px]" style={{ color: verdictColor(d.verdict) }}>{d.verdict}</span>}
                </div>
                <p className="mt-2 text-[14px] font-medium leading-snug text-text-primary">{d.summary}</p>
                {d.rationale && <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">{d.rationale}</p>}
                {d.evidence.length > 0 && (
                  <ul className="mt-2 space-y-1 border-t border-border pt-2">
                    {d.evidence.map((e, i) => (
                      <li key={i} className="text-[12px] text-text-secondary"><span className="text-text-muted">{e.kind}:</span> {(e.excerpt ?? e.ref).slice(0, 120)}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-5">
        <p className="text-[12px] font-medium text-text-secondary">ABC candidates (deterministic; A - [B evidence] - C, degree-penalized)</p>
        {abc.length === 0 ? (
          <p className="mt-2 text-[13px] text-text-muted">No ABC candidates in this build.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {abc.map((a, i) => (
              <div key={i} className="rounded-lg border border-border bg-surface p-3">
                <p className="text-[13px] text-text-primary">
                  <span className="font-medium">{a.payload.a_label}</span>
                  <span className="text-text-muted"> (comm {a.payload.a_community}) </span>
                  <span className="text-accent"> --- </span>
                  <span className="font-medium">{a.payload.c_label}</span>
                  <span className="text-text-muted"> (comm {a.payload.c_community})</span>
                  <span className="ml-2 font-mono text-[11px] text-text-muted">score {a.score.toFixed(3)}</span>
                </p>
                {(a.payload.path_evidence ?? []).slice(0, 2).map((p, j) => (
                  <p key={j} className="mt-1 text-[11px] leading-relaxed text-text-muted">
                    via <span className="text-text-secondary">{p.b_label}</span>: A [{p.a_leg_papers.map((x) => x.title).join("; ")}] / C [{p.c_leg_papers.map((x) => x.title).join("; ")}]
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden="true" />;
}
