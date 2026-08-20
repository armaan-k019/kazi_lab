"use client";

import { useLab } from "@/components/shell/lab-context";

// ---------------------------------------------------------------------------
// Diagnostics panel: the detailed web-build stats that used to be six boxes
// on the page (nothing deleted, relocated), plus the rebuild action.
// ---------------------------------------------------------------------------

export function DiagnosticsPanel() {
  const { data, building, rebuildWeb } = useLab();
  const s = data?.run?.stats;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void rebuildWeb()}
          disabled={building}
          className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
        >
          {building ? "Rebuilding…" : "Rebuild web"}
        </button>
        {building && <span className="text-[12px] text-text-secondary">this takes a minute…</span>}
      </div>

      {!s && <p className="text-[13px] text-text-muted">No web build yet. Rebuild to weave the corpus into the portal.</p>}

      {s && (
        <div className="space-y-2">
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
            {s.projectionDensity ? `${(s.projectionDensity.beforeIdf * 100).toFixed(0)}% before, ${(s.projectionDensity.afterIdf * 100).toFixed(0)}% after` : "-"}
            <span className="mt-1 block text-[11px] text-text-muted">Fraction of paper pairs linked. A drop means IDF fractured the previously dense projection.</span>
          </Stat>
          <Stat label="Projection params">
            {s.projectionSweep
              ? `perplexity ${s.projectionSweep.chosen.perplexity}, early exaggeration ${s.projectionSweep.chosen.earlyExaggeration} (silhouette ${s.projectionSweep.chosen.silhouette.toFixed(3)})`
              : "defaults (no sweep recorded on this run; rebuild to tune)"}
            <span className="mt-1 block text-[11px] text-text-muted">Chosen by computed silhouette of the Louvain communities in 3D, not by eye.</span>
          </Stat>
          <Stat label="Orphan report">
            {s.orphanReport ? `${s.orphanReport.tinyCommunities.length} tiny communities, ${s.orphanReport.lowDegreePapers.length} low-degree papers` : "-"}
          </Stat>
          <Stat label="Communities">
            {(data?.communities ?? []).map((c) => `[${c.index}] ${c.label ?? "?"} (${c.size})`).join(" · ")}
          </Stat>
          <p className="text-[11px] text-text-muted">
            Visual tuning multipliers (cloud opacity/scale, bridge opacity) live on the portal toolbar behind the
            "dev" chip in development builds.
          </p>
        </div>
      )}
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
