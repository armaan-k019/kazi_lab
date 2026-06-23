"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import type {
  CriticContradiction,
  CriticFinding,
  CriticLatest,
  Library,
} from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";
import { isAllPapersLibrary } from "@/lib/library";

const ACCENT = "var(--accent)";
const FLAG = "#b4493b";
const MUTED = "var(--text-muted)";

// Sound verdicts read calm (accent), adverse ones are flagged (warm red), and
// the milder "partially_grounded" sits in between (muted).
function verdictColor(v: string): string {
  if (v === "genuine" || v === "justified" || v === "grounded") return ACCENT;
  if (v === "partially_grounded") return "var(--text-secondary)";
  return FLAG;
}
function severityColor(s: string | null): string {
  if (s === "high") return FLAG;
  if (s === "medium") return "#b07a4f";
  return MUTED;
}
const sevRank: Record<string, number> = { high: 3, medium: 2, low: 1 };

export function CriticView() {
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [data, setData] = useState<CriticLatest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [critiquing, setCritiquing] = useState(false);

  const active = libraries?.find((l) => l.id === activeId) ?? null;
  const activeName = active?.name ?? "library";
  const isGeneral = isAllPapersLibrary(active?.name);

  useEffect(() => {
    fetch("/api/libraries")
      .then((r) => r.json())
      .then((b: { libraries: Library[] }) => {
        setLibraries(b.libraries);
        // Default to the first non-general (critiquable) library.
        const firstReal = b.libraries.find((l) => !isAllPapersLibrary(l.name));
        setActiveId((firstReal ?? b.libraries[0])?.id ?? null);
      })
      .catch(() => setError("Could not load libraries."));
  }, []);

  const loadLatest = useCallback((libraryId: string) => {
    setData(null);
    setError(null);
    fetch(`/api/critic/latest?libraryId=${libraryId}`)
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error ?? "Could not load critique.");
        return b as CriticLatest;
      })
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (activeId) loadLatest(activeId);
  }, [activeId, loadLatest]);

  const runCritique = async () => {
    if (!activeId || critiquing) return;
    setCritiquing(true);
    setError(null);
    try {
      const res = await fetch("/api/critic/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libraryId: activeId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "The critique could not complete.");
      loadLatest(activeId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCritiquing(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
    >
      <h2 className="text-2xl font-semibold tracking-tight text-text-primary">
        Critic
      </h2>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-text-muted">
        An adversarial review of a library&rsquo;s synthesis: which contradictions
        are real, which finding labels are inflated, and where findings outrun
        their evidence. It confirms sound conclusions and flags a minority with
        passage-grounded reasons.
      </p>

      {/* Library selector */}
      {libraries && (
        <div className="mt-5 flex flex-wrap gap-2">
          {libraries.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => setActiveId(l.id)}
              className={`rounded-full border px-3 py-1 text-[13px] transition-colors ${
                l.id === activeId
                  ? "border-accent/50 bg-accent-dim text-accent"
                  : "border-border text-text-secondary hover:border-accent/30 hover:text-accent"
              }`}
            >
              {l.name}{" "}
              <span className="text-text-muted">{l.paperCount}</span>
            </button>
          ))}
        </div>
      )}

      {error && <p className="mt-4 text-[13px] text-[#b4493b]">{error}</p>}

      {/* General library: not critiqued. */}
      {isGeneral && (
        <p className="mt-8 max-w-md text-[15px] leading-relaxed text-text-muted">
          The general library is an all-papers view and is not critiqued. Switch
          to a research library to audit its synthesis.
        </p>
      )}

      {!isGeneral && data && !("general" in data && data.general) && (
        <CritiqueBody
          data={data as Exclude<CriticLatest, { general: true }>}
          libraryName={activeName}
          critiquing={critiquing}
          onCritique={runCritique}
        />
      )}
    </motion.div>
  );
}

function CritiqueBody({
  data,
  libraryName,
  critiquing,
  onCritique,
}: {
  data: Exclude<CriticLatest, { general: true }>;
  libraryName: string;
  critiquing: boolean;
  onCritique: () => void;
}) {
  if (!data.hasSynthesis) {
    return (
      <p className="mt-8 max-w-md text-[15px] leading-relaxed text-text-muted">
        Synthesize {libraryName} first. The Critic audits a completed synthesis
        run; there is nothing to review yet.
      </p>
    );
  }

  const adverse = buildTriage(data.contradictions, data.findings);

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={onCritique}
          disabled={critiquing}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
        >
          {data.run ? "Re-critique" : "Critique"}
        </button>
        {critiquing && (
          <span className="flex items-center gap-2 text-[13px] text-text-secondary">
            <Spinner /> critiquing the synthesis, this takes a minute…
          </span>
        )}
        {!critiquing && data.run && (
          <span className="text-[13px] text-text-muted">
            Last critiqued {formatRelativeTime(data.run.completedAt)} ·{" "}
            {data.contradictions.length} contradictions,{" "}
            {data.findings.length} findings audited
          </span>
        )}
      </div>

      {data.run?.notes && (
        <p className="mt-2 text-[12px] text-text-muted">{data.run.notes}</p>
      )}

      {!data.run && !critiquing && (
        <p className="mt-3 text-[13px] text-text-muted">
          Not yet critiqued. Run a critique to audit this synthesis.
        </p>
      )}

      {data.run && (
        <>
          {/* Triage: what to look at */}
          <section className="mt-8">
            <PanelLabel>What to look at</PanelLabel>
            {adverse.length === 0 ? (
              <p className="mt-2 text-[14px] text-accent">
                No issues flagged. The Critic confirmed the synthesis as sound.
              </p>
            ) : (
              <ol className="mt-3 space-y-2">
                {adverse.map((a) => (
                  <li
                    key={a.key}
                    className="flex items-start gap-2.5 text-[13px]"
                  >
                    <SeverityBadge severity={a.severity} />
                    <span className="text-text-secondary">{a.summary}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* Contradictions */}
          {data.contradictions.length > 0 && (
            <section className="mt-10">
              <PanelLabel>Contradictions ({data.contradictions.length})</PanelLabel>
              <div className="mt-3 space-y-3">
                {data.contradictions.map((c) => (
                  <ContradictionCard key={c.id} c={c} />
                ))}
              </div>
            </section>
          )}

          {/* Findings */}
          {data.findings.length > 0 && (
            <section className="mt-10">
              <PanelLabel>Findings ({data.findings.length})</PanelLabel>
              <div className="mt-3 space-y-3">
                {data.findings.map((f) => (
                  <FindingCard key={f.id} f={f} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

type TriageItem = { key: string; severity: string | null; summary: string };
function buildTriage(
  contradictions: CriticContradiction[],
  findings: CriticFinding[],
): TriageItem[] {
  const items: TriageItem[] = [];
  for (const c of contradictions) {
    if (c.verdict !== "genuine") {
      items.push({
        key: `c-${c.id}`,
        severity: c.severity,
        summary: `Contradiction looks ${c.verdict.replace("_", " ")}: ${
          c.fromPaperTitle ?? "a paper"
        } vs ${c.toPaperTitle ?? "another"}`,
      });
    }
  }
  for (const f of findings) {
    const labelBad = f.labelVerdict !== "justified";
    const groundBad = f.groundingVerdict !== "grounded";
    if (labelBad || groundBad) {
      const issues = [
        labelBad ? `label ${f.labelVerdict}` : null,
        groundBad ? f.groundingVerdict.replace("_", " ") : null,
      ]
        .filter(Boolean)
        .join(", ");
      items.push({
        key: `f-${f.id}`,
        severity: f.severity,
        summary: `Finding (${issues}): ${(f.statement ?? "").slice(0, 90)}`,
      });
    }
  }
  return items.sort(
    (a, b) => (sevRank[b.severity ?? ""] ?? 0) - (sevRank[a.severity ?? ""] ?? 0),
  );
}

function ContradictionCard({ c }: { c: CriticContradiction }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge color={verdictColor(c.verdict)}>{c.verdict.replace("_", " ")}</Badge>
        {c.confidence && (
          <span className="text-[12px] text-text-muted">{c.confidence} confidence</span>
        )}
        {c.verdict !== "genuine" && <SeverityBadge severity={c.severity} />}
      </div>
      <p className="mt-3 text-[13px] text-text-primary">
        “{c.fromClaimText ?? "claim"}”{" "}
        <span className="text-text-muted">({c.fromPaperTitle ?? "paper"})</span>
      </p>
      <p className="text-[13px] text-text-secondary">
        “{c.toClaimText ?? "claim"}”{" "}
        <span className="text-text-muted">({c.toPaperTitle ?? "paper"})</span>
      </p>
      {c.synthesisRationale && (
        <p className="mt-2 text-[12px] text-text-muted">
          Synthesis said: {c.synthesisRationale}
        </p>
      )}
      {c.rationale && (
        <p className="mt-2 text-[13px] leading-relaxed text-text-primary">
          {c.rationale}
        </p>
      )}
    </div>
  );
}

function FindingCard({ f }: { f: CriticFinding }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-[14px] font-medium leading-snug text-text-primary">
        {f.statement}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {f.synthesisLabel && (
          <span className="text-[12px] text-text-muted">
            labeled {f.synthesisLabel}
          </span>
        )}
        <Badge color={verdictColor(f.labelVerdict)}>{f.labelVerdict}</Badge>
        <Badge color={verdictColor(f.groundingVerdict)}>
          {f.groundingVerdict.replace("_", " ")}
        </Badge>
        {f.confidence && (
          <span className="text-[12px] text-text-muted">{f.confidence} confidence</span>
        )}
        {(f.labelVerdict !== "justified" || f.groundingVerdict !== "grounded") && (
          <SeverityBadge severity={f.severity} />
        )}
      </div>
      {f.independenceNote && (
        <p className="mt-2 text-[12px] text-text-muted">
          Independence: {f.independenceNote}
        </p>
      )}
      {f.rationale && (
        <p className="mt-2 text-[13px] leading-relaxed text-text-primary">
          {f.rationale}
        </p>
      )}
    </div>
  );
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ color, backgroundColor: "var(--surface-raised)" }}
    >
      {children}
    </span>
  );
}
function SeverityBadge({ severity }: { severity: string | null }) {
  if (!severity) return null;
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ color: severityColor(severity), backgroundColor: "var(--surface-raised)" }}
    >
      {severity} severity
    </span>
  );
}
function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[13px] font-medium text-text-secondary">{children}</h3>
  );
}
function Spinner() {
  return (
    <span
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent"
      aria-hidden="true"
    />
  );
}
