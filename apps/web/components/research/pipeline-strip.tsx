"use client";

import { useEffect, useMemo } from "react";
import type { PipelineLibrary, PipelineStageState } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";
import { AMBIENT, STATUS } from "@/lib/design-tokens";
import { useLab } from "@/components/shell/lab-context";

// ---------------------------------------------------------------------------
// Research's primary region: the SELECTED LIBRARY's pipeline as a horizontal
// progression (papers -> synthesis -> critic -> metrics -> cross-domain ->
// experiment -> document). Stage states come from /api/research/pipeline,
// which imports the scheduler's detectStaleStates: the strip and the
// scheduler can never disagree. Each stage opens its panel.
// ---------------------------------------------------------------------------

// Dots may use the mid green (non-text signal); the state WORDS use the
// text-safe variants so every text pairing holds AA.
const STAGE_TONE: Record<PipelineStageState, string> = {
  done: STATUS.ok,
  stale: STATUS.stale,
  missing: STATUS.missing,
  none_found: STATUS.neutral,
};
const STAGE_TEXT: Record<PipelineStageState, string> = {
  done: STATUS.okText,
  stale: STATUS.stale,
  missing: STATUS.missing,
  none_found: STATUS.neutral,
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
        <p className="text-mid text-ink-500">Deriving the pipeline state…</p>
      </div>
    );
  }
  if (!selected) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="max-w-md px-6 text-center font-display text-display leading-tight text-ink">No libraries yet<span className="mt-3 block font-sans text-mid font-normal text-ink-500">Create one in the Libraries panel to start the pipeline.</span></p>
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
    <div className="pointer-events-auto relative isolate flex h-full flex-col p-6 lg:pl-10 lg:pt-8">
      {/* Legibility scrim: a soft wash of ground color behind the strip's
          text so the ambient field never fights the foreground. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: `linear-gradient(to right, rgb(12 18 14 / ${AMBIENT.textScrim}) 0%, rgb(12 18 14 / ${AMBIENT.textScrim * 0.6}) 55%, transparent 90%)` }}
      />
      {/* Library chips: the shared selection every Research panel reads. */}
      <div className="flex flex-wrap items-center gap-4">
        {libs.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => setSelectedLibraryId(l.id)}
            className={`caps-label pb-1 transition-colors duration-(--motion-disclose) ${
              l.id === selected.id ? "!text-ink border-b-2 border-green" : "border-b-2 border-transparent hover:!text-ink-700"
            }`}
          >
            {l.name}
            <span className="ml-1 font-mono text-micro text-ink-500">{l.paperCount}</span>
          </button>
        ))}
      </div>

      {/* The progression. */}
      <div className="mt-6 flex flex-1 flex-col justify-center">
        <p className="caps-label">pipeline</p>
        <p className="mt-1 font-display text-display leading-tight text-ink">{selected.name}</p>
        <div className="mt-8 flex flex-wrap items-start gap-y-6">
          {stages.map((s, i) => {
            const st = selected.stages[s.key].state;
            return (
              <div key={s.key} className="flex items-center">
                <button
                  type="button"
                  onClick={() => openPanel(STAGE_PANEL[s.key])}
                  className="group min-w-[96px] text-left"
                  title={`open ${STAGE_PANEL[s.key]}`}
                >
                  <p className="flex items-center gap-1.5">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: STAGE_TONE[st] }} />
                    <span className="caps-label transition-colors duration-(--motion-disclose) group-hover:!text-ink">{s.label}</span>
                  </p>
                  <p className="mt-1 pl-3.5 text-caption" style={{ color: STAGE_TEXT[st] }}>{STAGE_WORD[st]}</p>
                  <p className="mt-0.5 h-[15px] pl-3.5 font-mono text-micro text-ink-500">{s.detail}</p>
                </button>
                {i < stages.length - 1 && <span className="mx-3 mt-1 h-px w-8 shrink-0 self-start bg-hairline-strong" aria-hidden="true" style={{ marginTop: "5px" }} />}
              </div>
            );
          })}
        </div>
        <p className="mt-10 max-w-xl text-small leading-relaxed text-ink-500">
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
