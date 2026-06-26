"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import type {
  CrossDomainLatest,
  CrossDomainLevel,
  CrossDomainLink,
} from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";

const ACCENT = "var(--accent)";
const CANDIDATE = "#b07a4f"; // warm amber: needs pressure-testing, not asserted

const LEVELS: { key: CrossDomainLevel; label: string; blurb: string }[] = [
  {
    key: "method",
    label: "Method recurrence",
    blurb: "The same algorithm or technique appearing in more than one project.",
  },
  {
    key: "claim",
    label: "Claim recurrence",
    blurb: "The same kind of audited finding recurring across projects.",
  },
  {
    key: "concept",
    label: "Concept rhymes (candidates)",
    blurb:
      "Emergent rhymes that point to the method or claim links underneath. Always candidates until the cross-domain Critic tests them.",
  },
];

export function CrossDomainView() {
  const [data, setData] = useState<CrossDomainLatest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(() => {
    setError(null);
    fetch("/api/cross-domain/latest")
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error ?? "Could not load cross-domain results.");
        return b as CrossDomainLatest;
      })
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/cross-domain/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "The cross-domain synthesis could not complete.");
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const eligibleCount = data?.eligible.length ?? 0;
  const canRun = eligibleCount >= 2;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
    >
      <h2 className="text-2xl font-semibold tracking-tight text-text-primary">
        Cross-Domain
      </h2>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-text-muted">
        A lab-level read across projects: what genuinely recurs from one domain to
        another, grounded in the methods and audited findings underneath. Method
        and claim recurrences are asserted only with concrete cross-library
        evidence. Concept rhymes are recorded as candidates for the cross-domain
        Critic to pressure-test. The lab thesis is a hypothesis here, not a lens.
      </p>

      {error && <p className="mt-4 text-[13px] text-[#b4493b]">{error}</p>}

      {data && !canRun && (
        <p className="mt-8 max-w-md text-[15px] leading-relaxed text-text-muted">
          Cross-domain synthesis reads across at least two synthesized projects.
          {eligibleCount === 0
            ? " No projects are synthesized yet."
            : ` Only ${eligibleCount} project is synthesized so far (${data.eligible
                .map((e) => e.name)
                .join(", ")}).`}{" "}
          Add and synthesize at least two research projects, then run it here.
        </p>
      )}

      {data && canRun && (
        <div className="mt-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              onClick={run}
              disabled={running}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
            >
              {data.run ? "Re-run cross-domain synthesis" : "Run cross-domain synthesis"}
            </button>
            {running && (
              <span className="flex items-center gap-2 text-[13px] text-text-secondary">
                <Spinner /> reasoning across {eligibleCount} projects, this takes a minute…
              </span>
            )}
            {!running && data.run && (
              <span className="text-[13px] text-text-muted">
                Last run {formatRelativeTime(data.run.completedAt)} · over{" "}
                {data.run.scope.join(", ")}
              </span>
            )}
          </div>

          <p className="mt-3 text-[12px] text-text-muted">
            Eligible projects:{" "}
            {data.eligible.map((e) => e.name).join(", ")} (general excluded;
            unsynthesized projects skipped)
          </p>

          {!data.run && !running && (
            <p className="mt-3 text-[13px] text-text-muted">
              Not yet run. Run a cross-domain synthesis to surface grounded
              recurrences across these projects.
            </p>
          )}

          {data.run?.notes && (
            <section className="mt-6 rounded-xl border border-border bg-surface p-5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                Honest read
              </p>
              <p className="mt-2 text-[14px] leading-relaxed text-text-primary">
                {data.run.notes}
              </p>
            </section>
          )}

          {data.run &&
            LEVELS.map(({ key, label, blurb }) => {
              const links = data.links.filter((l) => l.level === key);
              return (
                <section key={key} className="mt-10">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-[13px] font-medium text-text-secondary">
                      {label} ({links.length})
                    </h3>
                  </div>
                  <p className="mt-1 text-[12px] text-text-muted">{blurb}</p>
                  {links.length === 0 ? (
                    <p className="mt-3 text-[13px] text-text-muted">
                      None at this level{key === "method" ? " (no shared methods grounded across projects)" : ""}.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {links.map((l) => (
                        <LinkCard key={l.id} link={l} />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
        </div>
      )}
    </motion.div>
  );
}

function LinkCard({ link }: { link: CrossDomainLink }) {
  const accent = link.isCandidate ? CANDIDATE : ACCENT;
  return (
    <div
      className="rounded-xl border bg-surface p-4"
      style={{ borderColor: link.isCandidate ? "color-mix(in srgb, #b07a4f 35%, transparent)" : "var(--border)" }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ color: accent, backgroundColor: "var(--surface-raised)" }}
        >
          {link.isCandidate ? "candidate · needs pressure-testing" : "grounded"}
        </span>
        {link.confidence && (
          <span className="text-[12px] text-text-muted">{link.confidence} confidence</span>
        )}
        <span className="flex flex-wrap items-center gap-1">
          {link.libraries.map((lib) => (
            <span
              key={lib.id}
              className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-secondary"
            >
              {lib.name}
            </span>
          ))}
        </span>
      </div>

      <p className="mt-3 text-[14px] font-medium leading-snug text-text-primary">
        {link.summary}
      </p>
      {link.rationale && (
        <p className="mt-1.5 text-[13px] leading-relaxed text-text-secondary">
          {link.rationale}
        </p>
      )}

      {link.evidence.length > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
            Evidence
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {link.evidence.map((e) => (
              <li key={e.id} className="text-[12px] leading-relaxed text-text-secondary">
                <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-text-muted">
                  {e.libraryName}
                </span>{" "}
                <span className="text-text-muted">{e.kind}:</span>{" "}
                <span className="text-text-primary">{e.ref}</span>
                {e.excerpt && <span className="text-text-muted"> — {e.excerpt}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
