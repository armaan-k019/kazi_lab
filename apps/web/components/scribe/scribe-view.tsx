"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { IngestResult, Library, PaperSummary } from "@/lib/types";
import { formatAuthors, formatPublished, formatTimestamp } from "@/lib/format";
import { PaperDetail } from "./paper-detail";
import { LibrarySwitcher } from "./library-switcher";
import { SynthesisControl } from "./synthesis-control";
import { SynthesisView } from "./synthesis/synthesis-view";

type IngestStage = "fetching" | "extracting" | "writing";
const STAGES: IngestStage[] = ["fetching", "extracting", "writing"];

// Spacing between sequential batch requests, to stay friendly to arXiv rate
// limits (the fetcher's own retry/backoff handles transient 429/503).
const BATCH_DELAY_MS = 5000;

type BatchStatus = "queued" | "ingesting" | "done" | "failed";
type BatchItem = {
  url: string;
  status: BatchStatus;
  linkedExisting?: boolean;
  claimsInserted?: number;
  error?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Split pasted text into a de-duplicated URL list (newline/comma separated).
function parseUrls(raw: string): string[] {
  const parts = raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...new Set(parts)];
}

export function ScribeView() {
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [activeLibraryId, setActiveLibraryId] = useState<string | null>(null);
  const [papers, setPapers] = useState<PaperSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [viewingSynthesis, setViewingSynthesis] = useState(false);

  const [url, setUrl] = useState("");
  const [working, setWorking] = useState(false);
  const [stage, setStage] = useState<IngestStage>("fetching");
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [batch, setBatch] = useState<BatchItem[] | null>(null);
  const stageTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const activeLibrary =
    libraries?.find((l) => l.id === activeLibraryId) ?? null;
  const activeName = activeLibrary?.name ?? "library";

  const fetchLibraries = useCallback(async (): Promise<Library[]> => {
    const res = await fetch("/api/libraries");
    if (!res.ok) throw new Error("Could not load libraries.");
    return (await res.json()).libraries as Library[];
  }, []);

  const fetchPapers = useCallback(
    async (libraryId: string): Promise<PaperSummary[]> => {
      const res = await fetch(`/api/scribe/papers?libraryId=${libraryId}`);
      if (!res.ok) throw new Error("Could not load the corpus.");
      return (await res.json()).papers as PaperSummary[];
    },
    [],
  );

  // Re-fetch both libraries (counts) and the current library's papers.
  const refresh = useCallback(
    async (libraryId: string) => {
      const [libs, ps] = await Promise.all([
        fetchLibraries(),
        fetchPapers(libraryId),
      ]);
      setLibraries(libs);
      setPapers(ps);
    },
    [fetchLibraries, fetchPapers],
  );

  // Initial load: libraries, then default to "general".
  useEffect(() => {
    (async () => {
      try {
        const libs = await fetchLibraries();
        setLibraries(libs);
        const general = libs.find((l) => l.name === "general") ?? libs[0];
        setActiveLibraryId(general?.id ?? null);
      } catch (e) {
        setLoadError((e as Error).message);
      }
    })();
  }, [fetchLibraries]);

  // Load papers whenever the active library changes.
  useEffect(() => {
    if (!activeLibraryId) return;
    let cancelled = false;
    setPapers(null);
    fetchPapers(activeLibraryId)
      .then((ps) => {
        if (!cancelled) {
          setPapers(ps);
          setLoadError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setLoadError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [activeLibraryId, fetchPapers]);

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
  useEffect(() => () => stopStageCycle(), []);

  const handleSelectLibrary = (id: string) => {
    setActiveLibraryId(id);
    setSelectedId(null);
    setNotice(null);
    setIngestError(null);
  };

  const handleCreateLibrary = async (name: string, description: string) => {
    const res = await fetch("/api/libraries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: description || undefined }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "Could not create the library.");
    const libs = await fetchLibraries();
    setLibraries(libs);
    setActiveLibraryId(body.library.id); // switch to the new library
  };

  const handleDeleteLibrary = async (id: string) => {
    const res = await fetch(`/api/libraries/${id}`, { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Could not delete the library.");
    const libs = await fetchLibraries();
    setLibraries(libs);
    const general = libs.find((l) => l.name === "general") ?? libs[0];
    setActiveLibraryId(general?.id ?? null); // fall back to general
  };

  const handleRemoveFromLibrary = async (paperId: string) => {
    if (!activeLibraryId) return;
    const res = await fetch(
      `/api/scribe/papers/${paperId}/libraries/${activeLibraryId}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Could not remove the paper.");
    }
    await refresh(activeLibraryId);
  };

  const handleDeletePaper = async (paperId: string) => {
    const res = await fetch(`/api/scribe/papers/${paperId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Could not delete the paper.");
    }
    if (selectedId === paperId) setSelectedId(null);
    if (activeLibraryId) await refresh(activeLibraryId);
  };

  // One ingest call against the existing single-paper route.
  const ingestOne = useCallback(
    async (target: string): Promise<IngestResult> => {
      const res = await fetch("/api/scribe/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target, libraryId: activeLibraryId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Ingestion failed.");
      return body as IngestResult;
    },
    [activeLibraryId],
  );

  const patchBatch = (index: number, patch: Partial<BatchItem>) => {
    setBatch((prev) =>
      prev
        ? prev.map((it, i) => (i === index ? { ...it, ...patch } : it))
        : prev,
    );
  };

  // Single URL: unchanged behavior (staged label + notice/error line).
  const runSingle = async (target: string) => {
    setWorking(true);
    setIngestError(null);
    setNotice(null);
    setBatch(null);
    startStageCycle();
    try {
      const result = await ingestOne(target);
      if (activeLibraryId) await refresh(activeLibraryId);
      setUrl("");
      setNotice(
        result.linkedExisting
          ? `Already in corpus, added to ${activeName}.`
          : `Ingested into ${activeName}. ${result.claimsInserted} claims extracted.`,
      );
    } catch (err) {
      setIngestError((err as Error).message);
    } finally {
      stopStageCycle();
      setWorking(false);
    }
  };

  // Multiple URLs: ingest sequentially with spacing; one failure never aborts
  // the rest. Per-URL status updates live.
  const runBatch = async (urls: string[]) => {
    setWorking(true);
    setIngestError(null);
    setNotice(null);
    setBatch(urls.map((u) => ({ url: u, status: "queued" as BatchStatus })));

    for (let i = 0; i < urls.length; i++) {
      if (i > 0) await sleep(BATCH_DELAY_MS);
      patchBatch(i, { status: "ingesting" });
      try {
        const r = await ingestOne(urls[i]);
        patchBatch(i, {
          status: "done",
          linkedExisting: r.linkedExisting,
          claimsInserted: r.claimsInserted,
        });
      } catch (err) {
        patchBatch(i, { status: "failed", error: (err as Error).message });
      }
    }

    if (activeLibraryId) await refresh(activeLibraryId);
    setUrl("");
    setWorking(false);
  };

  // Retry a single failed row after the batch settles.
  const retryItem = async (index: number) => {
    if (working || !batch) return;
    const item = batch[index];
    if (!item) return;
    setWorking(true);
    patchBatch(index, { status: "ingesting", error: undefined });
    try {
      const r = await ingestOne(item.url);
      patchBatch(index, {
        status: "done",
        linkedExisting: r.linkedExisting,
        claimsInserted: r.claimsInserted,
      });
      if (activeLibraryId) await refresh(activeLibraryId);
    } catch (err) {
      patchBatch(index, { status: "failed", error: (err as Error).message });
    } finally {
      setWorking(false);
    }
  };

  const handleIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (working || !activeLibraryId) return;
    const urls = parseUrls(url);
    if (urls.length === 0) return;
    if (urls.length === 1) {
      await runSingle(urls[0]);
    } else {
      await runBatch(urls);
    }
  };

  const parsedCount = parseUrls(url).length;
  const batchSummary = batch
    ? {
        ingested: batch.filter((b) => b.status === "done" && !b.linkedExisting)
          .length,
        linked: batch.filter((b) => b.status === "done" && b.linkedExisting)
          .length,
        failed: batch.filter((b) => b.status === "failed").length,
      }
    : null;

  if (selectedId) {
    return <PaperDetail id={selectedId} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div>
      {/* Library switcher */}
      {libraries && activeLibraryId && (
        <div className="mb-6">
          <LibrarySwitcher
            libraries={libraries}
            activeId={activeLibraryId}
            onSelect={handleSelectLibrary}
            onCreate={handleCreateLibrary}
            onDelete={handleDeleteLibrary}
          />
        </div>
      )}

      {viewingSynthesis && activeLibraryId ? (
        // Synthesis view, keyed by library so switching libraries reloads it.
        <SynthesisView
          key={activeLibraryId}
          libraryId={activeLibraryId}
          libraryName={activeName}
          onBack={() => setViewingSynthesis(false)}
        />
      ) : (
        <>
          {/* Synthesis control, scoped to the active library. Keyed by library
              id so switching libraries remounts it (resets state, stops polls). */}
          {activeLibraryId && (
            <SynthesisControl
              key={activeLibraryId}
              libraryId={activeLibraryId}
              libraryName={activeName}
              paperCount={activeLibrary?.paperCount ?? papers?.length ?? 0}
              onViewSynthesis={() => setViewingSynthesis(true)}
            />
          )}

          {/* Ingestion bar (single URL, or multiple for a batch) */}
          <form onSubmit={handleIngest} className="flex flex-col gap-2">
            <div className="flex items-start gap-2.5">
              <textarea
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={working}
                rows={parsedCount > 1 ? Math.min(parsedCount + 1, 8) : 2}
                placeholder="Paste any URL (arXiv, PDF, or article)"
                spellCheck={false}
                className="flex-1 resize-y rounded-lg border border-border bg-surface px-4 py-2.5 text-sm leading-relaxed text-text-primary placeholder:text-text-muted focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/15 disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={working || parsedCount === 0}
                className="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
              >
                {parsedCount > 1 ? `Ingest ${parsedCount}` : "Ingest"}
              </button>
            </div>

            <p className="text-[12px] text-text-muted">
              One URL per line for batch.
            </p>

            {/* Single-ingest status line (hidden while a batch is shown) */}
            {!batch && (
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
                {!working && !ingestError && !notice && (
                  <span className="text-text-muted">
                    Ingesting into{" "}
                    <span className="text-accent">{activeName}</span>
                  </span>
                )}
              </div>
            )}
          </form>

          {/* Batch progress + per-URL results */}
          {batch && (
            <BatchProgress
              items={batch}
              working={working}
              summary={batchSummary}
              onRetry={retryItem}
            />
          )}

      {/* Corpus list */}
      <div className="mt-8">
        {loadError && <p className="text-sm text-text-secondary">{loadError}</p>}

        {!papers && !loadError && (
          <p className="text-[13px] text-text-muted">Loading…</p>
        )}

        {papers && papers.length === 0 && (
          <div className="flex min-h-[30vh] items-center">
            <p className="text-sm text-text-muted">
              No papers in {activeName} yet. Ingest one above.
            </p>
          </div>
        )}

        {papers && papers.length > 0 && (
          <p className="mb-4 text-[13px] text-text-muted">
            <span className="font-medium text-accent">{papers.length}</span>{" "}
            {papers.length === 1 ? "paper" : "papers"} in {activeName}
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
                    libraryName={activeName}
                    onSelect={() => setSelectedId(paper.id)}
                    onRemove={() => handleRemoveFromLibrary(paper.id)}
                    onDelete={() => handleDeletePaper(paper.id)}
                  />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
          </div>
        </>
      )}
    </div>
  );
}

function PaperRow({
  paper,
  libraryName,
  onSelect,
  onRemove,
  onDelete,
}: {
  paper: PaperSummary;
  libraryName: string;
  onSelect: () => void;
  onRemove: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group relative rounded-lg border-l-2 border-transparent px-3 py-4 transition-colors hover:border-accent/60 hover:bg-surface-raised">
      {/* Full-row click target sits behind the content. */}
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Open ${paper.title}`}
        className="absolute inset-0 z-0 rounded-lg"
      />

      <div className="pointer-events-none relative z-10 pr-4">
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
      </div>

      {/* Per-paper controls, revealed on hover. */}
      <div className="absolute bottom-3 right-3 z-20 flex items-center gap-3 text-[12px]">
        {confirmingDelete ? (
          <div className="flex items-center gap-2">
            <span className="text-text-secondary">Delete everywhere?</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(onDelete)}
              className="font-medium text-[#b4493b] transition-opacity hover:opacity-80 disabled:opacity-40"
            >
              Yes
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmingDelete(false)}
              className="text-text-muted transition-colors hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              disabled={busy}
              onClick={() => run(onRemove)}
              title={`Remove from ${libraryName} (paper stays in the corpus)`}
              className="text-text-muted transition-colors hover:text-text-primary disabled:opacity-40"
            >
              Remove
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
              className="text-text-muted transition-colors hover:text-[#b4493b] disabled:opacity-40"
            >
              Delete
            </button>
          </div>
        )}
      </div>
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

function BatchProgress({
  items,
  working,
  summary,
  onRetry,
}: {
  items: BatchItem[];
  working: boolean;
  summary: { ingested: number; linked: number; failed: number } | null;
  onRetry: (index: number) => void;
}) {
  return (
    <div className="mt-3 rounded-xl border border-border bg-surface p-3">
      {working ? (
        <p className="mb-2 px-1 text-[13px] text-text-muted">
          Ingesting {items.length} sources sequentially…
        </p>
      ) : (
        summary && (
          <p className="mb-2 px-1 text-[13px] text-text-secondary">
            <span className="text-accent">{summary.ingested} ingested</span>
            {", "}
            <span className="text-text-muted">{summary.linked} linked</span>
            {", "}
            <span
              className={
                summary.failed > 0 ? "text-[#b4493b]" : "text-text-muted"
              }
            >
              {summary.failed} failed
            </span>
          </p>
        )
      )}
      <ul className="divide-y divide-border">
        {items.map((it, i) => (
          <li
            key={`${i}-${it.url}`}
            className="flex items-center justify-between gap-3 px-1 py-2 text-[13px]"
          >
            <span className="min-w-0 flex-1 truncate text-text-secondary">
              {it.url}
            </span>
            <span className="shrink-0">
              {it.status === "queued" && (
                <span className="text-text-muted">queued</span>
              )}
              {it.status === "ingesting" && (
                <span className="flex items-center gap-1.5 text-text-secondary">
                  <Spinner /> ingesting…
                </span>
              )}
              {it.status === "done" &&
                (it.linkedExisting ? (
                  <span className="text-text-muted">
                    added · already in corpus
                  </span>
                ) : (
                  <span className="text-accent">
                    ingested · {it.claimsInserted ?? 0} claims
                  </span>
                ))}
              {it.status === "failed" && (
                <span className="flex items-center gap-2">
                  <span className="text-[#b4493b]">
                    {it.error ?? "failed"}
                  </span>
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => onRetry(i)}
                    className="text-text-muted transition-colors hover:text-accent disabled:opacity-40"
                  >
                    retry
                  </button>
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
