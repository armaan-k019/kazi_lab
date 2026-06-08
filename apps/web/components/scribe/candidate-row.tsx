"use client";

import { useState } from "react";
import type { DiscoveryCandidate } from "@/lib/types";

// Shared discovery candidate row used by the paper-detail Explore area, the
// library gaps view, and the open-question search. Reuses the existing ingest
// pipeline so an ingested suggestion becomes fully grounded corpus data.
export function CandidateRow({
  candidate,
  libraryId,
  libraryName,
  onIngested,
  provenance,
}: {
  candidate: DiscoveryCandidate;
  libraryId: string;
  libraryName: string;
  onIngested?: () => void;
  provenance?: React.ReactNode;
}) {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">(
    "idle",
  );
  const [note, setNote] = useState<string | null>(null);

  const run = async () => {
    if (!candidate.ingestableUrl) return;
    setState("working");
    setNote(null);
    try {
      const res = await fetch("/api/scribe/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: candidate.ingestableUrl, libraryId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Ingest failed.");
      setState("done");
      setNote(
        body.linkedExisting
          ? "added (already in corpus)"
          : `ingested · ${body.claimsInserted ?? 0} claims`,
      );
      onIngested?.();
    } catch (e) {
      setState("error");
      setNote((e as Error).message);
    }
  };

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="min-w-0">
        <p className="text-[14px] leading-snug text-text-primary">
          {candidate.title || "untitled"}
        </p>
        <p className="mt-0.5 text-[12px] text-text-muted">
          {candidate.year ?? "year unknown"}
          {candidate.citedByCount != null &&
            ` · cited ${candidate.citedByCount.toLocaleString()}`}
        </p>
        {provenance && (
          <p className="mt-1 text-[12px] text-text-secondary">{provenance}</p>
        )}
      </div>

      <div className="shrink-0 text-right text-[12px]">
        {state === "done" ? (
          <span className="text-accent">{note}</span>
        ) : state === "working" ? (
          <span className="flex items-center gap-1.5 text-text-secondary">
            <Spinner /> working…
          </span>
        ) : candidate.inThisLibrary ? (
          <span className="text-text-muted">in this library</span>
        ) : candidate.ingestableUrl ? (
          <button
            type="button"
            onClick={run}
            className="font-medium text-accent transition-opacity hover:opacity-80"
          >
            {candidate.inCorpus
              ? `add to ${libraryName}`
              : `ingest into ${libraryName}`}
          </button>
        ) : candidate.doi ? (
          <a
            href={`https://doi.org/${candidate.doi}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-muted transition-colors hover:text-accent"
          >
            view ↗
          </a>
        ) : (
          <span className="text-text-muted">no source</span>
        )}
        {state === "error" && note && (
          <p className="mt-1 max-w-[180px] text-[#b4493b]">{note}</p>
        )}
      </div>
    </div>
  );
}

export function Spinner() {
  return (
    <span
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent"
      aria-hidden="true"
    />
  );
}
