"use client";

import { useLab } from "@/components/shell/lab-context";

// ---------------------------------------------------------------------------
// Diagnostics panel, editorial skin: the same detailed stats, set as a
// definition list (caps label, then content) separated by hairlines instead
// of boxed cards. Machine numbers stay mono.
// ---------------------------------------------------------------------------

export function DiagnosticsPanel() {
  const { data, building, rebuildWeb } = useLab();
  const s = data?.run?.stats;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void rebuildWeb()}
          disabled={building}
          className="rounded-(--radius-control) bg-green-deep px-3 py-1.5 text-ui font-medium text-paper transition-opacity duration-(--motion-disclose) hover:opacity-90 disabled:cursor-default disabled:opacity-50"
        >
          {building ? "Rebuilding…" : "Rebuild web"}
        </button>
        {building && <span className="text-small text-ink-600">this takes a minute…</span>}
      </div>

      {!s && <p className="text-ui text-ink-500">No web build yet. Rebuild to weave the corpus into the portal.</p>}

      {s && (
        <div className="divide-y divide-hairline">
          <Stat label="Nodes">
            {s.nodes ? `${s.nodes.papers} papers, ${s.nodes.claims} claims, ${s.nodes.methods} methods, ${s.nodes.datasets} datasets, ${s.nodes.concepts} concepts (${s.nodes.conceptMerges} merges)` : "-"}
          </Stat>
          <Stat label="Edges">
            {s.edges ? Object.entries(s.edges).map(([k, v]) => `${k} ${v}`).join(", ") : "-"}
            {typeof s.citations === "number" ? ` · citations ${s.citations}` : ""}
          </Stat>
          <Stat label="Modularity">
            <span className="font-mono">{typeof s.modularity === "number" ? s.modularity.toFixed(3) : "-"}</span>
            <span className="mt-1 block text-caption text-ink-500">Emergent-partition modularity on the IDF-thresholded projection (library-independent sanity metric).</span>
          </Stat>
          <Stat label="Projection density (IDF)">
            {s.projectionDensity ? (
              <span className="font-mono">{(s.projectionDensity.beforeIdf * 100).toFixed(0)}% before, {(s.projectionDensity.afterIdf * 100).toFixed(0)}% after</span>
            ) : (
              "-"
            )}
            <span className="mt-1 block text-caption text-ink-500">Fraction of paper pairs linked. A drop means IDF fractured the previously dense projection.</span>
          </Stat>
          <Stat label="Projection params">
            {s.projectionSweep ? (
              <span className="font-mono">perplexity {s.projectionSweep.chosen.perplexity}, early exaggeration {s.projectionSweep.chosen.earlyExaggeration} (silhouette {s.projectionSweep.chosen.silhouette.toFixed(3)})</span>
            ) : (
              "defaults (no sweep recorded on this run; rebuild to tune)"
            )}
            <span className="mt-1 block text-caption text-ink-500">Chosen by computed silhouette of the Louvain communities in 3D, not by eye.</span>
          </Stat>
          <Stat label="Orphan report">
            {s.orphanReport ? `${s.orphanReport.tinyCommunities.length} tiny communities, ${s.orphanReport.lowDegreePapers.length} low-degree papers` : "-"}
          </Stat>
          <Stat label="Communities">
            {(data?.communities ?? []).map((c) => `[${c.index}] ${c.label ?? "?"} (${c.size})`).join(" · ")}
          </Stat>
        </div>
      )}
      {s && (
        <p className="text-caption text-ink-500">
          Visual tuning multipliers (cloud opacity/scale, bridge opacity) live on the portal toolbar behind the
          "dev" chip in development builds.
        </p>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-3 first:pt-0">
      <p className="caps-label">{label}</p>
      <p className="mt-1 pl-5 text-small leading-relaxed text-ink-700">{children}</p>
    </div>
  );
}
