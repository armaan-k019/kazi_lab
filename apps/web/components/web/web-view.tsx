"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { WebAbcCandidate, WebDiscovery, WebLatest } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";
import { WebGraph3D } from "./web-graph-3d";

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
  const [showEdges, setShowEdges] = useState(false);

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

  const post = async (path: string, setBusy: (b: boolean) => void) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const b = await res.json();
      if (!res.ok) throw new Error(b.error ?? "The operation could not complete.");
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openPaper = (refId: string) => window.open(`/?paper=${refId}`, "_self");

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: "easeOut" }}>
      <h2 className="text-2xl font-semibold tracking-tight text-text-primary">Research Web</h2>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-text-muted">
        The corpus as one 3D knowledge graph over the paper embeddings. Papers cluster into emergent
        communities; bridge analytics and distance-forced Swanson ABC discovery surface cross-domain
        hypotheses, grounded in ConceptNet and audited by the existing cross-domain Critic. The
        machine computes and grounds; it never asserts.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => post("/api/web/build", setBuilding)} disabled={building || proposing} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50">
          {building ? "Rebuilding…" : "Rebuild web"}
        </button>
        <button type="button" onClick={() => post("/api/web/propose", setProposing)} disabled={building || proposing || !data?.run} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-default disabled:opacity-50">
          {proposing ? "Proposing…" : "Propose crossovers"}
        </button>
        {data?.run && (
          <label className="flex items-center gap-2 text-[12px] text-text-secondary">
            <input type="checkbox" checked={showEdges} onChange={(e) => setShowEdges(e.target.checked)} /> edges
          </label>
        )}
        {(building || proposing) && <span className="flex items-center gap-2 text-[13px] text-text-secondary"><Spinner /> this takes a minute…</span>}
        {data?.run?.completedAt && !building && !proposing && <span className="text-[13px] text-text-muted">built {formatRelativeTime(data.run.completedAt)}</span>}
      </div>

      {error && <p className="mt-4 text-[13px] text-[#b4493b]">{error}</p>}

      {data && !data.run && (
        <p className="mt-8 max-w-md text-[15px] leading-relaxed text-text-muted">No web built yet. Rebuild the web to weave the corpus into a 3D graph.</p>
      )}

      {data?.run && (
        <>
          <SanityStats data={data} />
          <div className="mt-6 rounded-xl border border-border bg-surface p-3">
            <WebGraph3D nodes={data.nodes} edges={data.edges} communities={data.communities} showEdges={showEdges} onSelect={openPaper} />
          </div>
          <DiscoveriesPanel abc={data.abc} discoveries={data.discoveries} />
        </>
      )}
    </motion.div>
  );
}

function SanityStats({ data }: { data: WebLatest }) {
  const s = data.run!.stats;
  const density = s.projectionDensity;
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
      <Stat label="Modularity">
        {typeof s.modularity === "number" ? s.modularity.toFixed(3) : "-"}
        <span className="mt-1 block text-[11px] text-text-muted">Emergent-partition modularity on the IDF-thresholded projection (library-independent sanity metric).</span>
      </Stat>
      <Stat label="Projection density (IDF)">
        {density ? `${(density.beforeIdf * 100).toFixed(0)}% before, ${(density.afterIdf * 100).toFixed(0)}% after` : "-"}
        <span className="mt-1 block text-[11px] text-text-muted">Fraction of paper pairs linked. A drop means IDF fractured the previously dense projection.</span>
      </Stat>
      <Stat label="Orphan report">
        {orphan ? `${orphan.tinyCommunities.length} tiny communities, ${orphan.lowDegreePapers.length} low-degree papers` : "-"}
      </Stat>
      <Stat label="Communities">
        {data.communities.map((c) => `[${c.index}] ${c.label ?? "?"} (${c.size})`).join(" · ")}
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
        <p className="text-[12px] font-medium text-text-secondary">ABC candidates (deterministic; A - [B] - C, degree-penalized, distance-forced)</p>
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
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-text-muted">
                  score {a.score.toFixed(3)}
                  {a.payload.domain_distance_factor !== undefined ? ` = base ${a.payload.base_score?.toFixed(3)} x distance ${a.payload.domain_distance_factor.toFixed(2)}` : ""}
                  {a.payload.community_similarity != null ? ` (community sim ${a.payload.community_similarity.toFixed(2)})` : ""}
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
