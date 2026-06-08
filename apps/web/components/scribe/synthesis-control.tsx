"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  SynthesisCountSet,
  SynthesisLatest,
  SynthesisStatus,
} from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";

type Phase = "idle" | "running" | "done" | "error";
const WORDS = ["reading corpus", "finding connections", "writing results"];

// Synthesis control for one library. The parent mounts it with key={libraryId},
// so switching libraries remounts it: state resets and the poll/cleanup cancels,
// preventing a stale poll from one library bleeding into another.
export function SynthesisControl({
  libraryId,
  libraryName,
  paperCount,
  onViewSynthesis,
}: {
  libraryId: string;
  libraryName: string;
  paperCount: number;
  onViewSynthesis: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [counts, setCounts] = useState<SynthesisCountSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<SynthesisLatest>(null);
  const [word, setWord] = useState(WORDS[0]);

  const canSynthesize = paperCount >= 2;

  const refetchLatest = useCallback(async () => {
    try {
      const res = await fetch(`/api/synthesis/latest?libraryId=${libraryId}`);
      if (!res.ok) return;
      const body = await res.json();
      setLatest(body.latest as SynthesisLatest);
    } catch {
      /* transient; leave indicator as-is */
    }
  }, [libraryId]);

  // Load the last-synthesized indicator on mount (and on library change).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/synthesis/latest?libraryId=${libraryId}`);
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setLatest(body.latest as SynthesisLatest);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryId]);

  // Poll status while a run is in flight.
  useEffect(() => {
    if (phase !== "running" || !runId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/synthesis/status?runId=${runId}`);
        if (!res.ok) return;
        const s = (await res.json()) as SynthesisStatus;
        if (cancelled) return;
        if (s.status === "completed") {
          setCounts(s.counts);
          setPhase("done");
          refetchLatest();
        } else if (s.status === "failed") {
          setError(s.error ?? "Synthesis failed.");
          setPhase("error");
        }
      } catch {
        /* transient network error; keep polling */
      }
    };
    const id = setInterval(tick, 2500);
    tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase, runId, refetchLatest]);

  // Cycle honest, approximate status words while running.
  useEffect(() => {
    if (phase !== "running") return;
    let i = 0;
    setWord(WORDS[0]);
    const id = setInterval(() => {
      i = (i + 1) % WORDS.length;
      setWord(WORDS[i]);
    }, 5000);
    return () => clearInterval(id);
  }, [phase]);

  const run = async () => {
    setPhase("running");
    setError(null);
    setCounts(null);
    setRunId(null);
    try {
      const res = await fetch("/api/synthesis/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libraryId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not start synthesis.");
      setRunId(body.runId as string);
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  };

  const latestText = latest
    ? `Last synthesized ${formatRelativeTime(latest.completedAt)} · ${latest.findingCount} findings`
    : "Not yet synthesized";

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-center gap-3">
        {phase === "running" ? (
          <span className="flex items-center gap-2 text-[13px] text-text-secondary">
            <Spinner />
            Synthesizing {libraryName}…{" "}
            <span className="text-text-muted">{word}</span>
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={run}
              disabled={!canSynthesize}
              className="rounded-lg border border-accent/40 px-4 py-2 text-[13px] font-medium text-accent transition-colors hover:bg-accent-dim disabled:cursor-default disabled:border-border disabled:text-text-muted disabled:hover:bg-transparent"
            >
              {phase === "done" || phase === "error"
                ? "Synthesize again"
                : "Synthesize"}
            </button>
            {!canSynthesize && (
              <span className="text-[12px] text-text-muted">
                needs at least 2 papers
              </span>
            )}
          </>
        )}

        {phase === "done" && counts && (
          <span className="text-[13px] text-accent">
            ✓ {counts.themeCount} themes, {counts.findingCount} findings,{" "}
            {counts.relationCount} connections, {counts.openQuestionCount} open
            questions
          </span>
        )}

        {phase === "error" && error && (
          <span className="text-[13px] text-[#b4493b]">{error}</span>
        )}
      </div>

      <p className="mt-1.5 text-[12px] text-text-muted">
        {latestText}
        {latest && (
          <>
            {" · "}
            <button
              type="button"
              onClick={onViewSynthesis}
              className="text-accent transition-opacity hover:opacity-80"
            >
              view synthesis
            </button>
          </>
        )}
      </p>
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
