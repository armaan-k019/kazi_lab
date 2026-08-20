"use client";

import { useMemo, useState } from "react";
import type { GroupedFinding } from "@kazi-lab/web-graph/abc-grouping";
import type { WebProposeDiagnostics, WebProposeOutcome } from "@/lib/types";
import { useLab } from "@/components/shell/lab-context";

// ---------------------------------------------------------------------------
// Discoveries panel: deterministic grouped findings (never an LLM summary),
// audited crossover proposals, and the propose action. A collapsed finding is
// three scannable lines; everything else is nested behind disclosures.
// ---------------------------------------------------------------------------

function verdictColor(v: string | null): string {
  if (v === "confirmed" || v === "promoted") return "var(--accent)";
  if (v === "demoted") return "#b07a4f";
  if (v === "rejected") return "#b4493b";
  return "var(--text-muted)";
}

function serviceColor(status: string): string {
  if (status === "ok") return "#6fb08a";
  if (status === "degraded") return "#b07a4f";
  if (status === "unavailable") return "#b4493b";
  return "var(--text-muted)";
}

export function DiscoveriesPanel() {
  const ctx = useLab();
  const { data, groups, selection, setSelection, playThought, proposing, propose, proposeOutcome, paperTitle } = ctx;
  const commLabel = useMemo(() => new Map((data?.communities ?? []).map((c) => [c.index, c.label])), [data]);
  const labelOf = (i: number) => (i >= 0 ? (commLabel.get(i) ?? `community ${i}`) : "unassigned");

  // Portal-to-panel: a selected paper filters findings to those involving it.
  const paperFilter = selection?.kind === "paper" ? selection.refId : null;
  const visibleGroups = useMemo(() => {
    if (!paperFilter) return groups;
    return groups.filter((g) => [...g.evidence.aPapers, ...g.evidence.cPapers].some((p) => p.id === paperFilter));
  }, [groups, paperFilter]);

  const discoveries = data?.discoveries ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void propose()}
          disabled={proposing || !data?.run}
          className="rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-default disabled:opacity-50"
        >
          {proposing ? "Proposing…" : "Propose crossovers"}
        </button>
        {proposing && <Spinner />}
      </div>

      {proposeOutcome && <ProposeOutcomePanel outcome={proposeOutcome} />}

      {paperFilter && (
        <div className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-dim/40 px-3 py-1.5">
          <span className="truncate text-[12px] text-text-secondary" title={paperTitle(paperFilter) ?? paperFilter}>
            involving: <span className="text-text-primary">{paperTitle(paperFilter) ?? "selected paper"}</span>
          </span>
          <button type="button" onClick={() => setSelection(null)} className="ml-auto shrink-0 text-[11px] text-text-muted underline-offset-2 hover:text-accent hover:underline">
            clear
          </button>
        </div>
      )}

      {/* Grouped ABC findings: the deterministic collapse. */}
      <section>
        <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
          Cross-domain findings ({visibleGroups.length}
          {paperFilter ? ` of ${groups.length}` : ""}) · deterministic, distance-forced
        </p>
        {visibleGroups.length === 0 && (
          <p className="mt-2 text-[13px] text-text-muted">
            {paperFilter ? "No findings involve this paper." : "No ABC candidates in this build."}
          </p>
        )}
        <div className="mt-2 space-y-2">
          {visibleGroups.map((g) => (
            <FindingCard
              key={g.signature}
              group={g}
              labelOf={labelOf}
              selected={selection?.kind === "finding" && selection.signature === g.signature}
              onHover={() => playThought(g.pairings[0].sourceIndex)}
              onSelect={() => {
                setSelection({ kind: "finding", signature: g.signature });
                playThought(g.pairings[0].sourceIndex);
              }}
              openPaper={ctx.openPaper}
            />
          ))}
        </div>
      </section>

      {/* Audited crossover proposals (existing capability, unchanged data). */}
      {discoveries.length > 0 && (
        <section>
          <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Crossover proposals (audited by the cross-domain Critic)</p>
          <div className="mt-2 space-y-2">
            {discoveries.map((d) => (
              <div key={d.id} className="rounded-xl border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ color: "#b07a4f", backgroundColor: "var(--surface-raised)" }}>
                    {d.verdict ? `critic: ${d.verdict}` : "candidate · needs pressure-testing"}
                  </span>
                  <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-secondary">{d.level}</span>
                  {d.verdict && <span className="text-[11px]" style={{ color: verdictColor(d.verdict) }}>{d.verdict}</span>}
                </div>
                <p className="mt-2 text-[13px] font-medium leading-snug text-text-primary">{d.summary}</p>
                {d.rationale && <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">{d.rationale}</p>}
                {d.evidence.length > 0 && (
                  <details className="mt-2 border-t border-border pt-2">
                    <summary className="cursor-pointer text-[11px] text-text-muted">evidence ({d.evidence.length})</summary>
                    <ul className="mt-1 space-y-1">
                      {d.evidence.map((e, i) => (
                        <li key={i} className="text-[12px] text-text-secondary"><span className="text-text-muted">{e.kind}:</span> {(e.excerpt ?? e.ref).slice(0, 140)}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// A grouped finding. Collapsed: three visual lines, scannable at a glance.
// Expanded (disclosure): every nested pairing, the evidence, the formula.
function FindingCard({
  group,
  labelOf,
  selected,
  onHover,
  onSelect,
  openPaper,
}: {
  group: GroupedFinding;
  labelOf: (i: number) => string;
  selected: boolean;
  onHover: () => void;
  onSelect: () => void;
  openPaper: (refId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const best = group.pairings[0];
  return (
    <div
      onMouseEnter={onHover}
      className={`rounded-xl border bg-surface p-3 transition-colors ${selected ? "border-accent/60" : "border-border hover:border-accent/30"}`}
      title="hover previews the chain in the portal; click pins it"
    >
      <button type="button" onClick={onSelect} className="block w-full text-left">
        {/* Line 1: the relationship headline. */}
        <p className="text-[13px] font-medium leading-snug text-text-primary">
          {labelOf(group.communityPair[0])} <span className="text-accent">&lt;-&gt;</span> {labelOf(group.communityPair[1])}
        </p>
        {/* Line 2: bridge concepts + best score. */}
        <p className="mt-0.5 truncate text-[12px] text-text-secondary" title={group.bridgeConcepts.join(", ")}>
          via <span className="text-text-primary">{group.bridgeConcepts.join(", ")}</span>
          <span className="text-text-muted"> · best {group.bestScore.toFixed(2)}</span>
        </p>
        {/* Line 3: meta, distance factor prominent. */}
        <p className="mt-0.5 text-[11px] text-text-muted">
          {group.pairings.length} pairing{group.pairings.length === 1 ? "" : "s"} · {group.evidence.distinctPaperCount} papers
          {group.distanceFactor !== null && (
            <span className="ml-1.5 rounded-full border border-border px-1.5 py-px font-mono text-[10px] text-text-secondary">distance x{group.distanceFactor.toFixed(2)}</span>
          )}
        </p>
      </button>

      <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-1.5 text-[11px] text-text-muted underline-offset-2 hover:text-text-secondary hover:underline">
        {expanded ? "collapse" : `details (${group.pairings.length} pairings)`}
      </button>

      {expanded && (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          <ul className="space-y-0.5">
            {group.pairings.map((p, i) => (
              <li key={i} className="text-[12px] text-text-secondary">
                {p.aLabel} <span className="text-accent">&lt;-&gt;</span> {p.cLabel}
                <span className="font-mono text-[10px] text-text-muted"> {p.score.toFixed(3)}</span>
              </li>
            ))}
          </ul>
          {best.baseScore !== null && group.distanceFactor !== null && (
            <p className="font-mono text-[10px] text-text-muted">
              score = base {best.baseScore.toFixed(3)} x distance {group.distanceFactor.toFixed(2)}
            </p>
          )}
          <button type="button" onClick={() => setShowEvidence((v) => !v)} className="text-[11px] text-text-muted underline-offset-2 hover:text-text-secondary hover:underline">
            {showEvidence
              ? "hide evidence"
              : `evidence (${group.evidence.distinctPaperCount} papers across ${(group.evidence.aPapers.length > 0 ? 1 : 0) + (group.evidence.cPapers.length > 0 ? 1 : 0)} legs)`}
          </button>
          {showEvidence && (
            <div className="space-y-1.5">
              <EvidenceLeg label="A leg" papers={group.evidence.aPapers} openPaper={openPaper} />
              <EvidenceLeg label="C leg" papers={group.evidence.cPapers} openPaper={openPaper} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EvidenceLeg({ label, papers, openPaper }: { label: string; papers: { id: string | null; title: string }[]; openPaper: (refId: string) => void }) {
  if (papers.length === 0) return null;
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wide text-text-muted">{label}</p>
      <ul className="mt-0.5 space-y-0.5">
        {papers.map((p, i) => (
          <li key={i} className="truncate text-[12px]" title={p.title}>
            {p.id ? (
              <button type="button" onClick={() => openPaper(p.id!)} className="max-w-full truncate text-left text-text-secondary underline-offset-2 hover:text-accent hover:underline">
                {p.title}
              </button>
            ) : (
              <span className="text-text-secondary">{p.title}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The last proposal run's outcome (moved intact from the old web view): the
// REAL reason and stage, with the stage-by-stage diagnostics behind "why".
export function ProposeOutcomePanel({ outcome }: { outcome: WebProposeOutcome }) {
  const [showWhy, setShowWhy] = useState(false);
  const tone = outcome.kind === "failed" ? "#b4493b" : outcome.kind === "nothing" ? "#b07a4f" : "var(--accent)";
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ color: tone, backgroundColor: "var(--surface-raised)" }}>
          {outcome.kind === "completed" ? "proposal run completed" : outcome.kind === "nothing" ? "nothing to propose" : `failed at stage: ${outcome.stage ?? "unknown"}`}
        </span>
        {outcome.diagnostics && (
          <button type="button" onClick={() => setShowWhy((s) => !s)} className="text-[11px] text-text-muted underline-offset-2 hover:text-text-secondary hover:underline">
            {showWhy ? "hide diagnostics" : "why?"}
          </button>
        )}
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-text-primary">{outcome.message}</p>
      {outcome.note && outcome.note !== outcome.message && <p className="mt-1 text-[12px] text-text-secondary">{outcome.note}</p>}
      {showWhy && outcome.diagnostics && <ProposeDiagnostics d={outcome.diagnostics} />}
    </div>
  );
}

function ProposeDiagnostics({ d }: { d: WebProposeDiagnostics }) {
  const stageTone = (s: string) => (s === "ok" ? "#6fb08a" : s === "failed" ? "#b4493b" : "#b07a4f");
  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Pipeline stages</p>
        <ul className="mt-1 space-y-0.5">
          {d.stages.map((s, i) => (
            <li key={i} className="font-mono text-[11px] text-text-secondary">
              <span style={{ color: stageTone(s.status) }}>[{s.status}]</span> {s.stage}
              {s.note && <span className="text-text-muted"> · {s.note}</span>}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Candidates</p>
        <p className="mt-1 text-[12px] text-text-secondary">
          {d.candidatesConsidered} considered · {d.proposalsFromModel} proposed by the model
        </p>
        {d.dropped.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {d.dropped.map((x, i) => (
              <li key={i} className="text-[11px] leading-relaxed text-text-muted">x{x.count} {x.reason}</li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">External services</p>
        <ul className="mt-1 space-y-0.5">
          {d.services.map((s, i) => (
            <li key={i} className="text-[11px] text-text-secondary">
              <span style={{ color: serviceColor(s.status) }}>{s.status}</span> {s.service}
              <span className="text-text-muted"> · {s.reason}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-text-muted">
          auto-critique: <span className="text-text-secondary">{d.critique}</span>
          {d.critiqueNote && <span> · {d.critiqueNote}</span>}
        </p>
      </div>
    </div>
  );
}

function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden="true" />;
}
