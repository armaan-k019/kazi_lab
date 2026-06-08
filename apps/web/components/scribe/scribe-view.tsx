"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { IngestResult, PaperSummary } from "@/lib/types";
import { formatAuthors, formatPublished, formatTimestamp } from "@/lib/format";
import { PaperDetail } from "./paper-detail";

type IngestStage = "fetching" | "extracting" | "writing";
const STAGES: IngestStage[] = ["fetching", "extracting", "writing"];

export function ScribeView() {
  const [papers, setPapers] = useState<PaperSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [url, setUrl] = useState("");
  const [working, setWorking] = useState(false);
  const [stage, setStage] = useState<IngestStage>("fetching");
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const stageTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadPapers = useCallback(async () => {
    try {
      const res = await fetch("/api/scribe/papers");
      if (!res.ok) throw new Error("Could not load the corpus.");
      const body = await res.json();
      setPapers(body.papers as PaperSummary[]);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    loadPapers();
  }, [loadPapers]);

  // The ingest POST runs fetch -> extract -> write server-side as one call. We
  // can't observe sub-steps, so advance an indicative label on a timer while
  // the request is in flight (it stalls on "writing" until the response lands).
  const startStageCycle = () => {
    setStage("fetching");
    let i = 0;
    stageTimer.current = setInterval(() => {
      i = Math.min(i + 1, STAGES.length - 1);
      setStage(STAGES[i]);
    }, 2600);
  };
  const stopStageCycle = () => {
    if (stageTimer.current) clearInterval(stageTimer.current);
    stageTimer.current = null;
  };

  const handleIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (!value || working) return;

    setWorking(true);
    setIngestError(null);
    setNotice(null);
    startStageCycle();

    try {
      const res = await fetch("/api/scribe/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: value }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? "Ingestion failed.");
      }
      const result = body as IngestResult;
      await loadPapers();
      setUrl("");
      setNotice(
        result.alreadyIngested
          ? "Already in the corpus."
          : `Ingested. ${result.claimsInserted} claims extracted.`,
      );
    } catch (err) {
      setIngestError((err as Error).message);
    } finally {
      stopStageCycle();
      setWorking(false);
    }
  };

  useEffect(() => () => stopStageCycle(), []);

  if (selectedId) {
    return (
      <PaperDetail id={selectedId} onBack={() => setSelectedId(null)} />
    );
  }

  return (
    <div>
      {/* Ingestion bar */}
      <form onSubmit={handleIngest} className="flex flex-col gap-2.5">
        <div className="flex gap-2.5">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={working}
            placeholder="Paste any URL (arXiv, PDF, or article)"
            spellCheck={false}
            className="flex-1 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/15 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={working || url.trim().length === 0}
            className="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
          >
            Ingest
          </button>
        </div>

        <div className="flex h-5 items-center gap-2 text-[13px]">
          {working && (
            <span className="flex items-center gap-2 text-text-secondary">
              <Spinner />
              {stage}…
            </span>
          )}
          {!working && ingestError && (
            <span className="text-text-secondary">{ingestError}</span>
          )}
          {!working && !ingestError && notice && (
            <span className="text-text-muted">{notice}</span>
          )}
        </div>
      </form>

      {/* Corpus list */}
      <div className="mt-8">
        {loadError && (
          <p className="text-sm text-text-secondary">{loadError}</p>
        )}

        {!papers && !loadError && (
          <p className="text-[13px] text-text-muted">Loading corpus…</p>
        )}

        {papers && papers.length === 0 && (
          <div className="flex min-h-[30vh] items-center">
            <p className="text-sm text-text-muted">
              No papers yet. Ingest one above.
            </p>
          </div>
        )}

        {papers && papers.length > 0 && (
          <p className="mb-4 text-[13px] text-text-muted">
            <span className="font-medium text-accent">{papers.length}</span>{" "}
            {papers.length === 1 ? "paper" : "papers"} in corpus
          </p>
        )}

        {papers && papers.length > 0 && (
          <ul className="-mx-3 divide-y divide-border">
            <AnimatePresence initial={false}>
              {papers.map((paper) => (
                <motion.li
                  key={paper.id}
                  layout
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                >
                  <PaperRow
                    paper={paper}
                    onSelect={() => setSelectedId(paper.id)}
                  />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </div>
  );
}

function PaperRow({
  paper,
  onSelect,
}: {
  paper: PaperSummary;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group block w-full rounded-lg border-l-2 border-transparent px-3 py-4 text-left transition-colors hover:border-accent/60 hover:bg-surface-raised"
    >
      <div className="flex items-start justify-between gap-4">
        <h3 className="text-[15px] font-medium leading-snug text-text-primary transition-colors group-hover:text-accent">
          {paper.title}
        </h3>
        <span className="shrink-0 text-[13px] font-medium text-accent">
          {paper.claimCount} {paper.claimCount === 1 ? "claim" : "claims"}
        </span>
      </div>
      <p className="mt-1.5 text-sm text-text-secondary">
        {formatAuthors(paper.authors)}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-text-muted">
        {paper.arxivId && (
          <span className="font-mono">arXiv:{paper.arxivId}</span>
        )}
        <span>Published {formatPublished(paper.publishedAt)}</span>
        <span>Ingested {formatTimestamp(paper.ingestedAt)}</span>
      </div>
    </button>
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
