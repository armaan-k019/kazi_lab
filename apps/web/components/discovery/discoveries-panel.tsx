"use client";

import { useMemo, useState } from "react";
import type { GroupedFinding } from "@kazi-lab/web-graph/abc-grouping";
import type { WebProposeDiagnostics, WebProposeOutcome } from "@/lib/types";
import { COLOR, STATUS } from "@/lib/design-tokens";
import { useLab } from "@/components/shell/lab-context";

// ---------------------------------------------------------------------------
// Discoveries panel, editorial skin. Structure is UNCHANGED from the grouping
// work: three scannable lines per collapsed finding, pairings and evidence
// nested behind disclosures, proposals below. Cards are gone; findings are
// entries separated by hairline rules and whitespace, selection is a green
// rule at the left edge.
// ---------------------------------------------------------------------------

function verdictColor(v: string | null): string {
  if (v === "confirmed" || v === "promoted") return STATUS.okText;
  if (v === "demoted") return STATUS.stale;
  if (v === "rejected") return STATUS.missing;
  return STATUS.neutral;
}

function serviceColor(status: string): string {
  if (status === "ok") return STATUS.okText;
  if (status === "degraded") return STATUS.stale;
  if (status === "unavailable") return STATUS.missing;
  return STATUS.neutral;
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
    <div className="space-y-10">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void propose()}
          disabled={proposing || !data?.run}
          className="rounded-(--radius-control) border border-hairline-strong px-3 py-1.5 text-ui font-medium text-ink-600 transition-colors duration-(--motion-disclose) hover:border-green hover:text-green-deep disabled:cursor-default disabled:opacity-50"
        >
          {proposing ? "Proposing…" : "Propose crossovers"}
        </button>
        {proposing && <Spinner />}
      </div>

      {proposeOutcome && <ProposeOutcomePanel outcome={proposeOutcome} />}

      {paperFilter && (
        <div className="flex items-center gap-2 border-l-2 border-green pl-3">
          <span className="truncate text-small text-ink-600" title={paperTitle(paperFilter) ?? paperFilter}>
            involving: <span className="text-ink">{paperTitle(paperFilter) ?? "selected paper"}</span>
          </span>
          <button type="button" onClick={() => setSelection(null)} className="ml-auto shrink-0 text-caption text-ink-500 underline-offset-2 hover:text-green-deep hover:underline">
            clear
          </button>
        </div>
      )}

      {/* Grouped ABC findings: the deterministic collapse, restyled only. */}
      <section>
        <p className="caps-label">
          Cross-domain findings <span className="font-mono">{visibleGroups.length}{paperFilter ? ` of ${groups.length}` : ""}</span>
        </p>
        {visibleGroups.length === 0 && (
          <p className="mt-3 text-ui text-ink-500">
            {paperFilter ? "No findings involve this paper." : "No ABC candidates in this build."}
          </p>
        )}
        <div className="mt-3 divide-y divide-hairline">
          {visibleGroups.map((g) => (
            <FindingEntry
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
          <p className="caps-label">Crossover proposals · audited by the cross-domain critic</p>
          <div className="mt-3 divide-y divide-hairline">
            {discoveries.map((d) => (
              <div key={d.id} className="py-4 first:pt-0">
                <div className="flex flex-wrap items-center gap-2 text-caption">
                  <span style={{ color: verdictColor(d.verdict) }}>{d.verdict ? `critic: ${d.verdict}` : "candidate · needs pressure-testing"}</span>
                  <span className="text-ink-400">·</span>
                  <span className="text-ink-500">{d.level}</span>
                </div>
                <p className="mt-1.5 font-display text-lead leading-snug text-ink">{d.summary}</p>
                {d.rationale && <p className="mt-1 text-small leading-relaxed text-ink-600">{d.rationale}</p>}
                {d.evidence.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-caption text-ink-500">evidence ({d.evidence.length})</summary>
                    <ul className="mt-1 space-y-1">
                      {d.evidence.map((e, i) => (
                        <li key={i} className="text-small text-ink-600"><span className="text-ink-500">{e.kind}:</span> {(e.excerpt ?? e.ref).slice(0, 140)}</li>
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

// A grouped finding as an editorial entry. Collapsed: the same three visual
// lines. Selected: a green rule at the left, not a border box.
function FindingEntry({
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
      className={`py-4 pl-3 transition-colors duration-(--motion-disclose) first:pt-0 ${selected ? "border-l-2 border-green" : "border-l-2 border-transparent"}`}
      title="hover previews the chain in the portal; click pins it"
    >
      <button type="button" onClick={onSelect} className="block w-full text-left">
        {/* Line 1: the relationship headline, in display type. */}
        <p className="font-display text-title leading-tight text-ink">
          {labelOf(group.communityPair[0])} <span className="text-green-deep">&lt;-&gt;</span> {labelOf(group.communityPair[1])}
        </p>
        {/* Line 2: bridge concepts + best score. */}
        <p className="mt-1 truncate text-ui text-ink-600" title={group.bridgeConcepts.join(", ")}>
          via <span className="text-ink">{group.bridgeConcepts.join(", ")}</span>
          <span className="text-ink-500"> · best <span className="font-mono text-small">{group.bestScore.toFixed(2)}</span></span>
        </p>
        {/* Line 3: meta, distance factor prominent, machine numbers in mono. */}
        <p className="mt-1 text-caption text-ink-500">
          <span className="font-mono">{group.pairings.length}</span> pairing{group.pairings.length === 1 ? "" : "s"} · <span className="font-mono">{group.evidence.distinctPaperCount}</span> papers
          {group.distanceFactor !== null && (
            <span className="ml-2 font-mono text-micro text-green-deep">distance x{group.distanceFactor.toFixed(2)}</span>
          )}
        </p>
      </button>

      <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-1.5 text-caption text-ink-500 underline-offset-2 transition-colors duration-(--motion-disclose) hover:text-ink hover:underline">
        {expanded ? "collapse" : `details (${group.pairings.length} pairings)`}
      </button>

      {expanded && (
        <div className="mt-3 space-y-2 pl-1">
          <ul className="space-y-0.5">
            {group.pairings.map((p, i) => (
              <li key={i} className="text-small text-ink-600">
                {p.aLabel} <span className="text-green-deep">&lt;-&gt;</span> {p.cLabel}
                <span className="ml-1 font-mono text-micro text-ink-500">{p.score.toFixed(3)}</span>
              </li>
            ))}
          </ul>
          {best.baseScore !== null && group.distanceFactor !== null && (
            <p className="font-mono text-micro text-ink-500">
              score = base {best.baseScore.toFixed(3)} x distance {group.distanceFactor.toFixed(2)}
            </p>
          )}
          <button type="button" onClick={() => setShowEvidence((v) => !v)} className="text-caption text-ink-500 underline-offset-2 hover:text-ink hover:underline">
            {showEvidence
              ? "hide evidence"
              : `evidence (${group.evidence.distinctPaperCount} papers across ${(group.evidence.aPapers.length > 0 ? 1 : 0) + (group.evidence.cPapers.length > 0 ? 1 : 0)} legs)`}
          </button>
          {showEvidence && (
            <div className="space-y-2">
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
      <p className="caps-label">{label}</p>
      <ul className="mt-1 space-y-0.5">
        {papers.map((p, i) => (
          <li key={i} className="truncate text-small" title={p.title}>
            {p.id ? (
              <button type="button" onClick={() => openPaper(p.id!)} className="max-w-full truncate text-left text-ink-600 underline-offset-2 hover:text-green-deep hover:underline">
                {p.title}
              </button>
            ) : (
              <span className="text-ink-600">{p.title}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The last proposal run's outcome (unchanged content, editorial dress: a
// toned rule instead of a card).
export function ProposeOutcomePanel({ outcome }: { outcome: WebProposeOutcome }) {
  const [showWhy, setShowWhy] = useState(false);
  const tone = outcome.kind === "failed" ? COLOR.missing : outcome.kind === "nothing" ? COLOR.warm : COLOR.greenDeep;
  return (
    <div className="border-l-2 pl-3" style={{ borderColor: tone }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption font-medium" style={{ color: tone }}>
          {outcome.kind === "completed" ? "proposal run completed" : outcome.kind === "nothing" ? "nothing to propose" : `failed at stage: ${outcome.stage ?? "unknown"}`}
        </span>
        {outcome.diagnostics && (
          <button type="button" onClick={() => setShowWhy((s) => !s)} className="text-caption text-ink-500 underline-offset-2 hover:text-ink hover:underline">
            {showWhy ? "hide diagnostics" : "why?"}
          </button>
        )}
      </div>
      <p className="mt-1.5 text-ui leading-relaxed text-ink">{outcome.message}</p>
      {outcome.note && outcome.note !== outcome.message && <p className="mt-1 text-small text-ink-600">{outcome.note}</p>}
      {showWhy && outcome.diagnostics && <ProposeDiagnostics d={outcome.diagnostics} />}
    </div>
  );
}

function ProposeDiagnostics({ d }: { d: WebProposeDiagnostics }) {
  const stageTone = (s: string) => (s === "ok" ? STATUS.okText : s === "failed" ? STATUS.missing : STATUS.stale);
  return (
    <div className="mt-3 space-y-4">
      <div>
        <p className="caps-label">Pipeline stages</p>
        <ul className="mt-1 space-y-0.5">
          {d.stages.map((s, i) => (
            <li key={i} className="font-mono text-caption text-ink-600">
              <span style={{ color: stageTone(s.status) }}>[{s.status}]</span> {s.stage}
              {s.note && <span className="text-ink-500"> · {s.note}</span>}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="caps-label">Candidates</p>
        <p className="mt-1 text-small text-ink-600">
          <span className="font-mono">{d.candidatesConsidered}</span> considered · <span className="font-mono">{d.proposalsFromModel}</span> proposed by the model
        </p>
        {d.dropped.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {d.dropped.map((x, i) => (
              <li key={i} className="text-caption leading-relaxed text-ink-500">x{x.count} {x.reason}</li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="caps-label">External services</p>
        <ul className="mt-1 space-y-0.5">
          {d.services.map((s, i) => (
            <li key={i} className="text-caption text-ink-600">
              <span style={{ color: serviceColor(s.status) }}>{s.status}</span> {s.service}
              <span className="text-ink-500"> · {s.reason}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-caption text-ink-500">
          auto-critique: <span className="text-ink-600">{d.critique}</span>
          {d.critiqueNote && <span> · {d.critiqueNote}</span>}
        </p>
      </div>
    </div>
  );
}

function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-hairline border-t-green" aria-hidden="true" />;
}
