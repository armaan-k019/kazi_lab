"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type {
  SynthesisFinding,
  SynthesisOpenQuestion,
  SynthesisResults,
  SynthesisTheme,
} from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";
import {
  aggregateEdges,
  relationColor,
  RELATION_COLOR,
  type GraphSelection,
  type PaperEdge,
} from "@/lib/synthesis-graph";
import { TimelineGraph } from "./timeline-graph";

export function SynthesisView({
  libraryId,
  libraryName,
  onBack,
}: {
  libraryId: string;
  libraryName: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<SynthesisResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphSelection | null>(null);
  const selectPaper = (id: string) => setSelected({ kind: "paper", id });

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setSelected(null);
    fetch(`/api/synthesis/results?libraryId=${libraryId}`)
      .then(async (res) => {
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(b.error ?? "Could not load synthesis.");
        }
        return res.json();
      })
      .then((d: SynthesisResults) => {
        if (!cancelled) setData(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId]);

  const edges: PaperEdge[] = useMemo(
    () => (data?.relations ? aggregateEdges(data.relations) : []),
    [data],
  );
  const paperTitle = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of data?.papers ?? []) m.set(p.id, p.title);
    return m;
  }, [data]);
  const claimInfo = useMemo(() => {
    const m = new Map<string, { text: string; paperId: string }>();
    for (const p of data?.papers ?? [])
      for (const c of p.claims) m.set(c.id, { text: c.text, paperId: p.id });
    return m;
  }, [data]);
  const narrationByPaper = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of data?.papers ?? [])
      if (p.narration) m.set(p.id, p.narration);
    return m;
  }, [data]);

  const back = (
    <button
      type="button"
      onClick={onBack}
      className="mb-6 text-[13px] text-text-secondary transition-colors hover:text-accent"
    >
      ← Corpus
    </button>
  );

  if (error) {
    return (
      <div>
        {back}
        <p className="text-sm text-text-secondary">{error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div>
        {back}
        <p className="text-[13px] text-text-muted">Loading synthesis…</p>
      </div>
    );
  }
  if (!data.run) {
    return (
      <div>
        {back}
        <div className="flex min-h-[40vh] flex-col items-start justify-center gap-2">
          <h2 className="text-lg font-medium text-text-secondary">
            No synthesis yet for {libraryName}.
          </h2>
          <p className="max-w-md text-[15px] leading-relaxed text-text-muted">
            Run synthesis from the corpus view to see the connections across this
            library&rsquo;s papers.
          </p>
        </div>
      </div>
    );
  }

  const { run, papers, findings, openQuestions, themes, relations } = data;
  const consensusCounts = {
    consensus: findings.filter((f) => f.consensus === "consensus").length,
    contested: findings.filter((f) => f.consensus === "contested").length,
    single: findings.filter((f) => f.consensus === "single-source").length,
  };
  // Distinct from "contested" findings: claim relations of type "contradicts"
  // (the red edges in the graph). Counted from the same client-side data.
  const contradictionCount = relations.filter(
    (r) => r.relationType === "contradicts",
  ).length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
    >
      {back}

      <h2 className="text-2xl font-semibold tracking-tight text-text-primary">
        Synthesis · {libraryName}
      </h2>
      <p className="mt-2 text-[13px] text-text-muted">
        {run.paperCount ?? papers.length} papers · synthesized{" "}
        {formatRelativeTime(run.completedAt)} · {run.counts.themeCount} themes,{" "}
        {run.counts.findingCount} findings, {run.counts.relationCount}{" "}
        connections, {run.counts.openQuestionCount} open questions
      </p>

      {/* Consensus summary */}
      <p className="mt-3 text-[13px] text-text-secondary">
        <span className="text-accent">{consensusCounts.consensus} consensus</span>
        {" · "}
        <span className="text-[#b4493b]">
          {consensusCounts.contested} contested
        </span>
        {" · "}
        <span className="text-text-muted">
          {consensusCounts.single} single-source
        </span>
        {" · "}
        <span className="text-[#b4493b]">
          {contradictionCount}{" "}
          {contradictionCount === 1 ? "contradiction" : "contradictions"}
        </span>
      </p>

      {/* Graph */}
      <section className="mt-6 rounded-xl border border-border bg-surface p-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pt-2 text-[12px] text-text-muted">
          <LegendDot color={RELATION_COLOR.supports} label="supports" />
          <LegendDot color={RELATION_COLOR.contradicts} label="contradicts" />
          <LegendDot color={RELATION_COLOR.extends} label="extends" />
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full border border-dashed border-text-muted"
              aria-hidden
            />
            open question
          </span>
          <span className="ml-auto">
            scroll to zoom · drag to pan · zoom in to reveal claims
          </span>
        </div>
        {edges.length === 0 && (
          <p className="px-3 py-2 text-[12px] text-text-muted">
            No cross-paper connections were found in this run.
          </p>
        )}
        <TimelineGraph
          papers={papers}
          edges={edges}
          relations={relations}
          openQuestions={openQuestions}
          selected={selected}
          onSelect={setSelected}
        />
      </section>

      {/* Selection detail (paper / claim / open question) */}
      {selected && (
        <section className="mt-4 rounded-xl border border-accent/30 bg-accent-dim/40 p-4">
          <DetailHeader onClose={() => setSelected(null)}>
            {selected.kind === "paper" &&
              (paperTitle.get(selected.id) ?? "Paper")}
            {selected.kind === "claim" && "Claim"}
            {selected.kind === "question" && "Open question"}
          </DetailHeader>

          {selected.kind === "paper" &&
            (() => {
              const narration = narrationByPaper.get(selected.id);
              const rels = relations.filter(
                (r) =>
                  r.fromPaperId === selected.id || r.toPaperId === selected.id,
              );
              return (
                <>
                  {narration && (
                    <p className="mt-2 text-[15px] leading-[1.65] text-text-primary">
                      {narration}
                    </p>
                  )}
                  {rels.length === 0 ? (
                    <p className="mt-3 text-[13px] text-text-muted">
                      {narration
                        ? "No cross-paper claim relations in this run."
                        : "This paper has no cross-paper claim relations in this run."}
                    </p>
                  ) : (
                    <>
                      {narration && (
                        <p className="mt-4 text-[12px] font-medium text-text-muted">
                          Relations
                        </p>
                      )}
                      <ul className="mt-2 space-y-3">
                        {rels.map((r) => {
                    const outgoing = r.fromPaperId === selected.id;
                    const otherId = outgoing ? r.toPaperId : r.fromPaperId;
                    return (
                      <RelationItem
                        key={r.id}
                        type={r.relationType}
                        direction={outgoing ? "→" : "←"}
                        other={paperTitle.get(otherId) ?? "paper"}
                        fromText={r.fromClaimText}
                        toText={r.toClaimText}
                        rationale={r.rationale}
                      />
                    );
                        })}
                      </ul>
                    </>
                  )}
                </>
              );
            })()}

          {selected.kind === "claim" &&
            (() => {
              const info = claimInfo.get(selected.id);
              const rels = relations.filter(
                (r) =>
                  r.fromClaimId === selected.id || r.toClaimId === selected.id,
              );
              return (
                <div className="mt-2">
                  <p className="text-[14px] text-text-primary">
                    “{info?.text ?? "claim"}”
                  </p>
                  <p className="mt-1 text-[12px] text-text-muted">
                    {paperTitle.get(info?.paperId ?? "") ?? ""}
                  </p>
                  {rels.length > 0 && (
                    <ul className="mt-3 space-y-3">
                      {rels.map((r) => {
                        const outgoing = r.fromClaimId === selected.id;
                        const otherId = outgoing
                          ? r.toPaperId
                          : r.fromPaperId;
                        return (
                          <RelationItem
                            key={r.id}
                            type={r.relationType}
                            direction={outgoing ? "→" : "←"}
                            other={paperTitle.get(otherId) ?? "paper"}
                            fromText={r.fromClaimText}
                            toText={r.toClaimText}
                            rationale={r.rationale}
                          />
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })()}

          {selected.kind === "question" &&
            (() => {
              const q = openQuestions.find((x) => x.id === selected.id);
              if (!q) return null;
              return (
                <div className="mt-2">
                  <p className="text-[15px] font-medium text-text-primary">
                    {q.question}
                  </p>
                  {q.rationale && (
                    <p className="mt-2 text-[14px] leading-relaxed text-text-muted">
                      {q.rationale}
                    </p>
                  )}
                  {q.relatedPaperIds.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {q.relatedPaperIds.map((pid) => (
                        <PaperChip
                          key={pid}
                          id={pid}
                          paperTitle={paperTitle}
                          onChip={selectPaper}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
        </section>
      )}

      {/* Findings */}
      {findings.length > 0 && (
        <section className="mt-10">
          <PanelLabel>Findings</PanelLabel>
          <div className="mt-3 space-y-3">
            {findings.map((f) => (
              <FindingCard
                key={f.id}
                finding={f}
                paperTitle={paperTitle}
                onChip={selectPaper}
              />
            ))}
          </div>
        </section>
      )}

      {/* Open questions */}
      {openQuestions.length > 0 && (
        <section className="mt-10">
          <PanelLabel>Open questions</PanelLabel>
          <div className="mt-3 space-y-3">
            {openQuestions.map((q) => (
              <OpenQuestionCard
                key={q.id}
                question={q}
                paperTitle={paperTitle}
                onChip={selectPaper}
              />
            ))}
          </div>
        </section>
      )}

      {/* Themes */}
      {themes.length > 0 && (
        <section className="mt-10">
          <PanelLabel>Themes</PanelLabel>
          <div className="mt-3 space-y-3">
            {themes.map((t) => (
              <ThemeItem
                key={t.id}
                theme={t}
                paperTitle={paperTitle}
                onChip={selectPaper}
              />
            ))}
          </div>
        </section>
      )}
    </motion.div>
  );
}

function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[13px] font-medium text-text-secondary">{children}</h3>
  );
}

function DetailHeader({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <h3 className="text-[15px] font-medium text-text-primary">{children}</h3>
      <button
        type="button"
        onClick={onClose}
        className="shrink-0 text-[12px] text-text-muted transition-colors hover:text-text-primary"
      >
        close
      </button>
    </div>
  );
}

function RelationItem({
  type,
  direction,
  other,
  fromText,
  toText,
  rationale,
}: {
  type: string;
  direction: string;
  other: string;
  fromText: string;
  toText: string;
  rationale: string | null;
}) {
  const color = relationColor(type);
  return (
    <li className="border-l-2 pl-3 text-[13px]" style={{ borderColor: color }}>
      <span className="font-medium" style={{ color }}>
        {type}
      </span>{" "}
      <span className="text-text-muted">
        {direction} {other}
      </span>
      <p className="mt-1 text-text-primary">“{fromText}”</p>
      <p className="text-text-secondary">“{toText}”</p>
      {rationale && <p className="mt-1 text-text-muted">{rationale}</p>}
    </li>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block h-2 w-3 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

function PaperChip({
  id,
  paperTitle,
  onChip,
}: {
  id: string;
  paperTitle: Map<string, string>;
  onChip: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChip(id)}
      className="rounded-full bg-surface-raised px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:text-accent"
    >
      {paperTitle.get(id) ?? "paper"}
    </button>
  );
}

function ConsensusBadge({ value }: { value: string | null }) {
  const map: Record<string, { label: string; cls: string }> = {
    consensus: { label: "consensus", cls: "bg-accent-dim text-accent" },
    contested: {
      label: "contested",
      cls: "bg-[#b4493b]/10 text-[#b4493b]",
    },
    "single-source": {
      label: "single-source",
      cls: "bg-surface-raised text-text-muted",
    },
  };
  const m = value ? map[value] : null;
  if (!m) return null;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${m.cls}`}
    >
      {m.label}
    </span>
  );
}

function FindingCard({
  finding,
  paperTitle,
  onChip,
}: {
  finding: SynthesisFinding;
  paperTitle: Map<string, string>;
  onChip: (id: string) => void;
}) {
  const paperIds = [...new Set(finding.supports.map((s) => s.paperId))];
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[15px] font-medium leading-snug text-text-primary">
          {finding.statement}
        </p>
        <ConsensusBadge value={finding.consensus} />
      </div>
      {finding.detail && (
        <p className="mt-2 text-[14px] leading-relaxed text-text-secondary">
          {finding.detail}
        </p>
      )}
      {paperIds.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {paperIds.map((pid) => (
            <PaperChip
              key={pid}
              id={pid}
              paperTitle={paperTitle}
              onChip={onChip}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OpenQuestionCard({
  question,
  paperTitle,
  onChip,
}: {
  question: SynthesisOpenQuestion;
  paperTitle: Map<string, string>;
  onChip: (id: string) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-[15px] font-medium leading-snug text-text-primary">
        {question.question}
      </p>
      {question.rationale && (
        <p className="mt-2 text-[14px] leading-relaxed text-text-muted">
          {question.rationale}
        </p>
      )}
      {question.relatedPaperIds.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {question.relatedPaperIds.map((pid) => (
            <PaperChip
              key={pid}
              id={pid}
              paperTitle={paperTitle}
              onChip={onChip}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ThemeItem({
  theme,
  paperTitle,
  onChip,
}: {
  theme: SynthesisTheme;
  paperTitle: Map<string, string>;
  onChip: (id: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <p className="text-[14px] font-medium text-text-primary">{theme.name}</p>
      {theme.description && (
        <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">
          {theme.description}
        </p>
      )}
      {theme.paperIds.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {theme.paperIds.map((pid) => (
            <PaperChip
              key={pid}
              id={pid}
              paperTitle={paperTitle}
              onChip={onChip}
            />
          ))}
        </div>
      )}
    </div>
  );
}
