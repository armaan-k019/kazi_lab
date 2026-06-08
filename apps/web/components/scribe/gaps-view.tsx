"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { GapCandidate, LibraryGapsResult } from "@/lib/types";
import { CandidateRow, Spinner } from "./candidate-row";

// "What am I missing": scans the active library's citation graph for works that
// connect to multiple library papers. Keyed by libraryId in the parent so a
// library switch remounts it.
export function GapsView({
  libraryId,
  libraryName,
  onBack,
  onIngested,
}: {
  libraryId: string;
  libraryName: string;
  onBack: () => void;
  onIngested: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LibraryGapsResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/external/gaps?libraryId=${libraryId}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Could not scan the graph.");
        return body as LibraryGapsResult;
      })
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
    >
      <button
        type="button"
        onClick={onBack}
        className="mb-6 text-[13px] text-text-secondary transition-colors hover:text-accent"
      >
        ← Corpus
      </button>

      <h2 className="text-2xl font-semibold tracking-tight text-text-primary">
        What am I missing · {libraryName}
      </h2>
      <p className="mt-1.5 text-[12px] text-text-muted">
        Papers not in this library that connect to several of its papers, either
        as shared references or as works citing multiple members.
      </p>

      <div className="mt-6">
        {loading && (
          <p className="flex items-center gap-2 text-[13px] text-text-secondary">
            <Spinner /> scanning the citation graph…
          </p>
        )}
        {error && <p className="text-[13px] text-[#b4493b]">{error}</p>}
        {result && !result.available && (
          <p className="text-[13px] text-text-muted">{result.reason}</p>
        )}
        {result && result.available && result.candidates.length === 0 && (
          <p className="text-[13px] text-text-muted">
            No shared references or common citers found across this
            library&rsquo;s papers.
          </p>
        )}
        {result && result.available && result.candidates.length > 0 && (
          <div className="space-y-2">
            {result.candidates.map((c) => (
              <CandidateRow
                key={c.openalexId}
                candidate={c}
                libraryId={libraryId}
                libraryName={libraryName}
                onIngested={onIngested}
                provenance={<Provenance candidate={c} />}
              />
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function Provenance({ candidate }: { candidate: GapCandidate }) {
  const referenced = candidate.connections
    .filter((c) => c.type === "referenced")
    .map((c) => c.libraryPaperTitle);
  const cites = candidate.connections
    .filter((c) => c.type === "cites")
    .map((c) => c.libraryPaperTitle);
  const shorten = (t: string) => (t.length > 30 ? t.slice(0, 29) + "…" : t);
  const parts: string[] = [];
  if (referenced.length > 0) {
    parts.push(`referenced by ${referenced.map(shorten).join(", ")}`);
  }
  if (cites.length > 0) {
    parts.push(`cites ${cites.map(shorten).join(", ")}`);
  }
  return (
    <>
      <span className="text-accent">{candidate.connectionCount} of your papers</span>
      {" · "}
      {parts.join(" · ")}
    </>
  );
}
