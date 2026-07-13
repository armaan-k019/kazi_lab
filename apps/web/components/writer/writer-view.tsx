"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { WriterDocument, WriterLatest } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";

// Section kinds get a small marker so the reader sees what is computed, what is
// proposed, and what is an honest placeholder, mirroring the upstream separation.
function kindMarker(kind: string): { label: string; color: string } | null {
  if (kind === "computed") return { label: "COMPUTED", color: "var(--text-secondary)" };
  if (kind === "proposed") return { label: "PROPOSED", color: "#b07a4f" };
  if (kind === "placeholder") return { label: "NOT YET RUN", color: "#b07a4f" };
  return null;
}

export function WriterView() {
  const [data, setData] = useState<WriterLatest | null>(null);
  const [selExp, setSelExp] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((experimentalistRunId?: string) => {
    setError(null);
    fetch(`/api/writer/latest${experimentalistRunId ? `?experimentalistRunId=${experimentalistRunId}` : ""}`)
      .then((r) => r.json())
      .then((b: WriterLatest) => {
        setData(b);
        if (!experimentalistRunId && b.experimentalistRuns[0]) setSelExp(b.experimentalistRuns[0].id);
      })
      .catch(() => setError("Could not load the Writer."));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async () => {
    if (running || !selExp) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/writer/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ experimentalistRunId: selExp }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "The document could not be written.");
      load(selExp);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const runs = data?.experimentalistRuns ?? [];
  const doc = data?.document ?? null;

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: "easeOut" }}>
      <h2 className="text-2xl font-semibold tracking-tight text-text-primary">Writer</h2>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-text-muted">
        Documents a research thread end to end: the claim and its origin, the synthesis behind it,
        the computed meta-analysis, and the proposed experiment, as one grounded write-up. The Writer
        is a documentarian, not an author: every statement traces to something that already exists,
        and it introduces no new numbers, findings, or claims.
      </p>

      {data && runs.length === 0 && (
        <p className="mt-8 max-w-md text-[15px] leading-relaxed text-text-muted">
          No Experimentalist runs to document yet. Run the Experimentalist first, then write the
          thread here.
        </p>
      )}

      {data && runs.length > 0 && (
        <div className="mt-6 rounded-xl border border-border bg-surface p-4">
          <p className="text-[12px] font-medium text-text-secondary">Experimentalist thread to document</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <select
              value={selExp}
              onChange={(e) => setSelExp(e.target.value)}
              className="max-w-xl flex-1 rounded-lg border border-border bg-surface-raised px-3 py-2 text-[13px] text-text-primary"
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.hasDocument ? "• " : ""}
                  {r.claim.slice(0, 100)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={run}
              disabled={running || !selExp}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
            >
              {running ? "Writing…" : "Write document"}
            </button>
            {doc && (
              <a
                href={`/api/writer/export?writerRunId=${doc.writerRunId}`}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
              >
                Download markdown
              </a>
            )}
            {running && (
              <span className="flex items-center gap-2 text-[13px] text-text-secondary">
                <Spinner /> assembling the thread and writing, this takes a minute…
              </span>
            )}
          </div>
          <p className="mt-2 text-[11px] text-text-muted">A dot marks threads that already have a document.</p>
        </div>
      )}

      {error && <p className="mt-4 text-[13px] text-[#b4493b]">{error}</p>}

      {doc && <DocumentView doc={doc} />}
      {data && runs.length > 0 && !doc && !running && (
        <p className="mt-8 text-[15px] leading-relaxed text-text-muted">
          This thread has no document yet. Write one to see the research write-up.
        </p>
      )}
    </motion.div>
  );
}

function DocumentView({ doc }: { doc: WriterDocument }) {
  return (
    <article className="mt-8 max-w-3xl">
      <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-text-primary">{doc.title}</h1>
      <p className="mt-1.5 text-[12px] text-text-muted">
        {doc.completedAt ? formatRelativeTime(doc.completedAt) : ""}
        {doc.conferencesConsidered && doc.conferencesConsidered.length > 0
          ? ` · framed for ${doc.conferencesConsidered.join(", ")}`
          : ""}
      </p>
      {doc.notes && <p className="mt-1 text-[12px] text-[#b07a4f]">{doc.notes}</p>}

      <div className="mt-6 space-y-7">
        {doc.sections.map((s) => {
          const marker = kindMarker(s.kind);
          const provCount = doc.provenance?.[s.key]?.length ?? 0;
          return (
            <section key={s.key}>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[15px] font-semibold tracking-tight text-text-primary">{s.heading}</h2>
                {marker && (
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide"
                    style={{ color: marker.color, backgroundColor: "var(--surface-raised)" }}
                  >
                    {marker.label}
                  </span>
                )}
                {provCount > 0 && (
                  <span className="text-[11px] text-text-muted">{provCount} source{provCount === 1 ? "" : "s"}</span>
                )}
              </div>
              <p className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-text-primary">{s.body}</p>
            </section>
          );
        })}
      </div>
    </article>
  );
}

function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden="true" />;
}
