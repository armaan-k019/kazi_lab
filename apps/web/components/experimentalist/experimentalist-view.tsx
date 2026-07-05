"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import type {
  ExperimentInputs,
  ExperimentRun,
  MetaKey,
} from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";

type Mode = "abstract" | "cross_domain_link" | "library";
const MODES: { key: Mode; label: string; blurb: string }[] = [
  { key: "abstract", label: "Critic abstract", blurb: "A library's direction-setting claim_to_test." },
  { key: "cross_domain_link", label: "Cross-domain link", blurb: "A recurrence across libraries (confirmed/promoted first)." },
  { key: "library", label: "Library (field)", blurb: "No seeded claim; the most meta-analyzable question is derived." },
];

const VALIDITY_STATEMENT =
  "Variance-weighted random-effects meta-analysis is invalid for this corpus (dispersion is reported on ~1.3% of rows) and is not computed as a headline result. A per-key variance-weighted mean appears only where a slice has at least three dispersion-bearing rows, clearly labeled a subset.";

export function ExperimentalistView() {
  const [inputs, setInputs] = useState<ExperimentInputs | null>(null);
  const [runData, setRunData] = useState<ExperimentRun | null>(null);
  const [mode, setMode] = useState<Mode>("cross_domain_link");
  const [selRef, setSelRef] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLatest = useCallback((runId?: string) => {
    fetch(`/api/experimentalist/latest${runId ? `?runId=${runId}` : ""}`)
      .then((r) => r.json())
      .then((b: ExperimentRun) => setRunData(b))
      .catch(() => setError("Could not load the latest experiment run."));
  }, []);

  useEffect(() => {
    fetch("/api/experimentalist/inputs")
      .then((r) => r.json())
      .then((b: ExperimentInputs) => setInputs(b))
      .catch(() => setError("Could not load input options."));
    loadLatest();
  }, [loadLatest]);

  // Reset the selected ref to the first option whenever the mode changes.
  useEffect(() => {
    if (!inputs) return;
    const first =
      mode === "abstract"
        ? inputs.abstracts[0]?.id
        : mode === "cross_domain_link"
          ? inputs.links[0]?.id
          : inputs.libraries[0]?.id;
    setSelRef(first ?? "");
  }, [mode, inputs]);

  const run = async () => {
    if (running || !selRef) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/experimentalist/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputKind: mode, inputRef: selRef }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "The experiment could not complete.");
      loadLatest(body.runId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: "easeOut" }}>
      <h2 className="text-2xl font-semibold tracking-tight text-text-primary">Experimentalist</h2>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-text-muted">
        Takes a claim plus an evidence scope of one or more projects, runs a deterministic
        quantitative meta-analysis of what the literature already reports (the math is code, not a
        model), interprets it, and designs a verifiable experiment spec. Nothing is executed; the
        spec is execution-ready detail for a future layer.
      </p>

      {/* Input picker */}
      <div className="mt-6 rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap gap-2">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMode(m.key)}
              className={`rounded-full border px-3 py-1 text-[13px] transition-colors ${
                mode === m.key
                  ? "border-accent/50 bg-accent-dim text-accent"
                  : "border-border text-text-secondary hover:border-accent/30 hover:text-accent"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-text-muted">{MODES.find((m) => m.key === mode)?.blurb}</p>

        {inputs && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <select
              value={selRef}
              onChange={(e) => setSelRef(e.target.value)}
              className="max-w-xl flex-1 rounded-lg border border-border bg-surface-raised px-3 py-2 text-[13px] text-text-primary"
            >
              {mode === "abstract" &&
                inputs.abstracts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.library}: {a.claim.slice(0, 90)}
                  </option>
                ))}
              {mode === "cross_domain_link" &&
                inputs.links.map((l) => (
                  <option key={l.id} value={l.id}>
                    [{l.verdict ?? "uncritiqued"}] {l.summary.slice(0, 80)} ({l.libraries.join(" + ")})
                  </option>
                ))}
              {mode === "library" &&
                inputs.libraries.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
            </select>
            <button
              type="button"
              onClick={run}
              disabled={running || !selRef}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
            >
              {running ? "Working…" : "Run experiment"}
            </button>
            {running && (
              <span className="flex items-center gap-2 text-[13px] text-text-secondary">
                <Spinner /> pooling the literature, then interpreting and designing, this takes a minute…
              </span>
            )}
          </div>
        )}
        {inputs && mode === "abstract" && inputs.abstracts.length === 0 && (
          <p className="mt-2 text-[12px] text-text-muted">No Critic abstracts yet. Run the per-library Critic first.</p>
        )}
        {inputs && mode === "cross_domain_link" && inputs.links.length === 0 && (
          <p className="mt-2 text-[12px] text-text-muted">No cross-domain links yet. Run cross-domain synthesis first.</p>
        )}
      </div>

      {error && <p className="mt-4 text-[13px] text-[#b4493b]">{error}</p>}

      {runData?.run && <ResultsDoc data={runData} />}
      {runData && !runData.run && (
        <p className="mt-8 text-[15px] leading-relaxed text-text-muted">
          No experiment has been run yet. Pick a claim above and run one.
        </p>
      )}
    </motion.div>
  );
}

function ResultsDoc({ data }: { data: ExperimentRun }) {
  const run = data.run!;
  const interp = run.interpretation;
  const spec = data.spec;
  const meta = data.metaKeys ?? [];
  const qual = data.qualitative ?? [];

  return (
    <article className="mt-8 space-y-8">
      <header>
        <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Claim under test</p>
        <p className="mt-1 text-[17px] font-medium leading-snug text-text-primary">{run.claim}</p>
        <p className="mt-2 text-[12px] text-text-muted">
          scope: {run.scope.join(", ")}
          {run.completedAt ? ` · ${formatRelativeTime(run.completedAt)}` : ""}
        </p>
        {run.notes && <p className="mt-1 text-[12px] text-text-muted">{run.notes}</p>}
      </header>

      {/* META-ANALYSIS (computed) */}
      <section>
        <SectionLabel>Meta-analysis</SectionLabel>
        <p className="mt-1 text-[12px] italic text-text-muted">{VALIDITY_STATEMENT}</p>
        {meta.length === 0 ? (
          <p className="mt-3 text-[13px] text-text-muted">
            No cross-paper poolable metric keys in this scope (a key needs the same dataset, metric,
            task, and conditions reported by at least two papers).
          </p>
        ) : (
          <div className="mt-4 space-y-6">
            {meta.map((k, i) => (
              <MetaTable key={i} k={k} />
            ))}
          </div>
        )}
      </section>

      {/* QUALITATIVE degradation */}
      {qual.length > 0 && (
        <section>
          <SectionLabel>Qualitative evidence</SectionLabel>
          {qual.map((q) => (
            <div key={q.libraryName} className="mt-3">
              <p className="text-[13px] font-medium text-text-primary">
                {q.libraryName}{" "}
                <span className="font-normal text-text-muted">
                  — no structured metric layer yet; quantitative pooling unavailable. Audited-sound
                  findings stand in, no number fabricated.
                </span>
              </p>
              <ul className="mt-1.5 space-y-1">
                {q.findings.map((f, j) => (
                  <li key={j} className="text-[12px] leading-relaxed text-text-secondary">
                    • {f.excerpt}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {/* INTERPRETATION (LLM) */}
      {interp && (
        <section className="rounded-xl border border-accent/25 bg-accent-dim/30 p-5">
          <div className="flex items-center gap-2">
            <SectionLabel>Interpretation</SectionLabel>
            {interp.verdict && (
              <span className="rounded-full px-2 py-0.5 text-[11px] font-medium text-accent" style={{ backgroundColor: "var(--surface-raised)" }}>
                {interp.verdict}
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] italic text-text-muted">Model reading of the computed tables, constrained to the numbers above.</p>
          {interp.text && <p className="mt-2 text-[14px] leading-relaxed text-text-primary">{interp.text}</p>}
          {interp.caveats.length > 0 && (
            <div className="mt-3">
              <p className="text-[12px] font-medium text-text-secondary">Caveats</p>
              <ul className="mt-1 space-y-1">
                {interp.caveats.map((c, i) => (
                  <li key={i} className="text-[12px] leading-relaxed text-text-secondary">• {c}</li>
                ))}
              </ul>
            </div>
          )}
          {interp.unknowns.length > 0 && (
            <div className="mt-3">
              <p className="text-[12px] font-medium text-text-secondary">Genuinely unknown (targeted by the spec)</p>
              <ul className="mt-1 space-y-1">
                {interp.unknowns.map((u, i) => (
                  <li key={i} className="text-[12px] leading-relaxed text-text-secondary">• {u}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* EXPERIMENT SPEC */}
      {spec && (
        <section>
          <SectionLabel>Experiment spec</SectionLabel>
          <p className="mt-1 text-[11px] italic text-text-muted">Execution-ready design. Nothing is run here; a future executor consumes this.</p>
          {spec.title && <p className="mt-2 text-[15px] font-semibold text-text-primary">{spec.title}</p>}
          {spec.objective && <SpecField label="Objective">{spec.objective}</SpecField>}
          {spec.design?.arms && spec.design.arms.length > 0 && (
            <SpecField label="Design arms">
              <ul className="space-y-1">
                {spec.design.arms.map((a, i) => (
                  <li key={i} className="text-text-secondary">• {a}</li>
                ))}
              </ul>
              {spec.design.held_fixed && spec.design.held_fixed.length > 0 && (
                <p className="mt-1.5 text-[12px] text-text-muted">held fixed: {spec.design.held_fixed.join(", ")}</p>
              )}
            </SpecField>
          )}
          {spec.metrics && (
            <SpecField label="Metrics">
              {(spec.metrics.measured ?? []).join(", ")}
              {spec.metrics.datasets ? ` on ${spec.metrics.datasets.join(", ")}` : ""}
              {spec.metrics.why ? ` — ${spec.metrics.why}` : ""}
            </SpecField>
          )}
          {spec.confirmCriteria && <SpecField label="Confirms the claim if">{spec.confirmCriteria}</SpecField>}
          {spec.refuteCriteria && <SpecField label="Refutes the claim if">{spec.refuteCriteria}</SpecField>}
          {spec.environment && (
            <SpecField label="Environment">
              <span className="text-text-secondary">
                {spec.environment.dependencies ? `deps: ${spec.environment.dependencies.join(", ")}. ` : ""}
                {spec.environment.datasets ? `datasets: ${spec.environment.datasets.join(", ")}. ` : ""}
                {spec.environment.hardware ? `hardware: ${spec.environment.hardware}. ` : ""}
                {spec.environment.scale_notes ? `scale: ${spec.environment.scale_notes}` : ""}
              </span>
            </SpecField>
          )}
          {spec.verificationHarness && <SpecField label="Verification harness">{spec.verificationHarness}</SpecField>}
          {spec.humanDecisions && spec.humanDecisions.length > 0 && (
            <SpecField label="Left to a human">
              <ul className="space-y-1">
                {spec.humanDecisions.map((h, i) => (
                  <li key={i} className="text-text-secondary">• {h}</li>
                ))}
              </ul>
            </SpecField>
          )}
          {spec.limitations && <SpecField label="Limitations">{spec.limitations}</SpecField>}
        </section>
      )}
    </article>
  );
}

function MetaTable({ k }: { k: MetaKey }) {
  const methods = k.kinds.best_median?.methods ?? [];
  const higher = k.kinds.best_median?.higherIsBetter ?? true;
  const rankByM = new Map((k.kinds.rank?.ranks ?? []).map((r) => [r.method, r]));
  const winByM = new Map((k.kinds.vote_count?.winRates ?? []).map((w) => [w.method, w]));
  const conflicts = k.kinds.best_median?.conflicts ?? [];
  const vw = k.kinds.variance_weighted_subset;
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-[12px] text-text-primary">
          {k.dataset} · {k.metric} · {k.task} · {k.conditions}
        </p>
        <span className="text-[11px] text-text-muted">
          COMPUTED · {k.nPapers} papers · {k.nMethods} methods · {higher ? "higher" : "lower"}-is-better
        </span>
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-text-muted">
              <th className="py-1 pr-3 font-normal">method</th>
              <th className="py-1 pr-3 font-normal">pooled value</th>
              <th className="py-1 pr-3 font-normal">mean rank</th>
              <th className="py-1 pr-3 font-normal">win rate</th>
            </tr>
          </thead>
          <tbody>
            {methods.slice(0, 12).map((m) => {
              const rk = rankByM.get(m.method);
              const wr = winByM.get(m.method);
              return (
                <tr key={m.method} className="border-t border-border/60">
                  <td className="py-1 pr-3 text-text-primary">
                    {m.method}
                    {m.pooledFromSelf && <span className="ml-1 text-[10px] text-accent">self</span>}
                    {m.conflict && <span className="ml-1 text-[10px] text-[#b07a4f]">conflict</span>}
                  </td>
                  <td className="py-1 pr-3 font-mono text-text-secondary">{m.pooledValue}</td>
                  <td className="py-1 pr-3 font-mono text-text-secondary">
                    {rk ? `${rk.meanRank.toFixed(2)} / ${rk.nPapers}p` : "-"}
                  </td>
                  <td className="py-1 pr-3 font-mono text-text-secondary">
                    {wr ? `${(wr.winRate * 100).toFixed(0)}% (${wr.wins}-${wr.losses})` : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {conflicts.length > 0 && (
        <p className="mt-2 text-[11px] text-[#b07a4f]">
          conflicts kept distinct: {conflicts.map((c) => `${c.method}=${c.values.join(" vs ")}`).join("; ")}
        </p>
      )}
      {vw && (
        <p className="mt-2 text-[11px] text-text-muted">
          variance-weighted subset: mean {vw.weightedMean.toFixed(3)} — {vw.note}
        </p>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[13px] font-semibold uppercase tracking-wide text-text-secondary">{children}</h3>;
}
function SpecField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <p className="text-[12px] font-medium text-text-secondary">{label}</p>
      <div className="mt-0.5 text-[13px] leading-relaxed text-text-primary">{children}</div>
    </div>
  );
}
function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden="true" />;
}
