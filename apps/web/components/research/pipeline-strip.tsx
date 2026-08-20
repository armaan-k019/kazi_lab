"use client";

import { useEffect, useMemo } from "react";
import type { PipelineLibrary, PipelineStageState } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";
import { useLab } from "@/components/shell/lab-context";

// ---------------------------------------------------------------------------
// Research's primary region: the SELECTED LIBRARY's pipeline as a horizontal
// progression (papers -> synthesis -> critic -> metrics -> cross-domain ->
// experiment -> document). Stage states come from /api/research/pipeline,
// which imports the scheduler's detectStaleStates: the strip and the
// scheduler can never disagree. Each stage opens its panel.
// ---------------------------------------------------------------------------

const STAGE_TONE: Record<PipelineStageState, string> = {
  done: "#6fb08a",
  stale: "#b07a4f",
  missing: "#b4493b",
  none_found: "var(--text-muted)",
};

const STAGE_WORD: Record<PipelineStageState, string> = {
  done: "done",
  stale: "stale",
  missing: "missing",
  none_found: "scanned, none",
};

// Which panel each stage opens (metrics and cross-domain are scheduler work).
const STAGE_PANEL: Record<string, string> = {
  papers: "libraries",
  synthesis: "scribe",
  critic: "critic",
  metrics: "scheduler",
  crossDomain: "scheduler",
  experiment: "experimentalist",
  document: "writer",
};

export function PipelineStrip() {
  const { pipeline, selectedLibraryId, setSelectedLibraryId, openPanel } = useLab();
  const libs = useMemo(() => (pipeline?.libraries ?? []).filter((l) => !l.isAllPapers), [pipeline]);

  // Default selection: the first real library with papers.
  useEffect(() => {
    if (!selectedLibraryId && libs.length > 0) setSelectedLibraryId(libs[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libs.length]);

  const selected = libs.find((l) => l.id === selectedLibraryId) ?? libs[0] ?? null;

  if (!pipeline) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[14px] text-text-muted">Deriving the pipeline state…</p>
      </div>
    );
  }
  if (!selected) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="max-w-md px-6 text-center text-[14px] leading-relaxed text-text-muted">
          No libraries yet. Create one in the Libraries panel to start the pipeline.
        </p>
      </div>
    );
  }

  const stages: { key: keyof PipelineLibrary["stages"]; label: string; detail: string }[] = [
    { key: "papers", label: "papers", detail: `${selected.stages.papers.count}` },
    { key: "synthesis", label: "synthesis", detail: ageOf(selected.stages.synthesis.at) },
    { key: "critic", label: "critic", detail: ageOf(selected.stages.critic.at) },
    { key: "metrics", label: "metrics", detail: selected.stages.metrics.rows > 0 ? `${selected.stages.metrics.rows} rows` : "" },
    { key: "crossDomain", label: "cross-domain", detail: ageOf(selected.stages.crossDomain.at) },
    { key: "experiment", label: "experiment", detail: ageOf(selected.stages.experiment.at) },
    { key: "document", label: "document", detail: ageOf(selected.stages.document.at) },
  ];

  return (
    <div className="flex h-full flex-col p-4">
      {/* Library chips: the shared selection every Research panel reads. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {libs.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => setSelectedLibraryId(l.id)}
            className={`rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
              l.id === selected.id ? "border-accent/50 bg-accent-dim text-accent" : "border-border text-text-secondary hover:border-accent/30 hover:text-accent"
            }`}
          >
            {l.name}
            <span className="ml-1 text-[10px] text-text-muted">{l.paperCount}</span>
          </button>
        ))}
      </div>

      {/* The progression. */}
      <div className="mt-6 flex flex-1 flex-col justify-center">
        <p className="text-[13px] text-text-muted">
          <span className="text-[15px] font-semibold text-text-primary">{selected.name}</span> · pipeline
        </p>
        <div className="mt-4 flex flex-wrap items-stretch gap-y-3">
          {stages.map((s, i) => {
            const st = selected.stages[s.key].state;
            return (
              <div key={s.key} className="flex items-center">
                <button
                  type="button"
                  onClick={() => openPanel(STAGE_PANEL[s.key])}
                  className="min-w-[104px] rounded-xl border border-border bg-surface-raised px-3 py-2.5 text-left transition-colors hover:border-accent/40"
                  title={`open ${STAGE_PANEL[s.key]}`}
                >
                  <p className="text-[12px] font-medium text-text-primary">{s.label}</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-[11px]">
                    <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: STAGE_TONE[st] }} />
                    <span style={{ color: STAGE_TONE[st] }}>{STAGE_WORD[st]}</span>
                  </p>
                  <p className="mt-0.5 h-[14px] text-[10px] text-text-muted">{s.detail}</p>
                </button>
                {i < stages.length - 1 && <span className="mx-1.5 text-text-muted">-&gt;</span>}
              </div>
            );
          })}
        </div>
        <p className="mt-5 max-w-2xl text-[12px] leading-relaxed text-text-muted">
          Stage states come from the scheduler's own detection rules, so this strip and the task queue
          can never disagree. Click a stage to open its panel; amber is stale, red is missing.
        </p>
      </div>
    </div>
  );
}

function ageOf(iso: string | null): string {
  return iso ? formatRelativeTime(iso) : "";
}
