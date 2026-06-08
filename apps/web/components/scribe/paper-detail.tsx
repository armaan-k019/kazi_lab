"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import type {
  Claim,
  DiscoveryCandidate,
  ExternalAuthor,
  PaperContext,
  PaperDetail as PaperDetailData,
} from "@/lib/types";
import { formatPublished, formatTimestamp } from "@/lib/format";
import { CandidateRow, Spinner } from "./candidate-row";

type Props = {
  id: string;
  onBack: () => void;
  libraryId: string | null;
  libraryName: string;
  onIngested: () => void;
};

export function PaperDetail({
  id,
  onBack,
  libraryId,
  libraryName,
  onIngested,
}: Props) {
  const [data, setData] = useState<PaperDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/scribe/papers/${id}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "Could not load this paper.");
        }
        return res.json();
      })
      .then((d: PaperDetailData) => {
        if (!cancelled) setData(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
    >
      <button
        type="button"
        onClick={onBack}
        className="mb-8 text-[13px] text-text-secondary transition-colors hover:text-accent"
      >
        ← Corpus
      </button>

      {error && <p className="text-sm text-text-secondary">{error}</p>}

      {!data && !error && (
        <p className="text-[13px] text-text-muted">Loading…</p>
      )}

      {data && (
        <article className="max-w-3xl">
          <h2 className="text-[28px] font-semibold leading-tight tracking-tight text-text-primary">
            {data.paper.title}
          </h2>

          <p className="mt-3 text-[15px] leading-relaxed text-text-secondary">
            {data.authors.length > 0
              ? data.authors.map((a) => a.name).join(", ")
              : "unknown authors"}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px] text-text-muted">
            {data.paper.arxivId && (
              <span className="font-mono">arXiv:{data.paper.arxivId}</span>
            )}
            <span>Published {formatPublished(data.paper.publishedAt)}</span>
            <span>Ingested {formatTimestamp(data.paper.ingestedAt)}</span>
            {data.extraction && <span>{data.extraction.extractionVersion}</span>}
            <a
              href={data.paper.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent transition-opacity hover:opacity-80"
            >
              Source ↗
            </a>
          </div>

          {/* External identity (OpenAlex), only when confidently matched. */}
          {data.external &&
            (data.external.citedByCount != null || data.external.doi) && (
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-text-muted">
                {data.external.citedByCount != null && (
                  <span>
                    Cited {data.external.citedByCount.toLocaleString()} times
                  </span>
                )}
                {data.external.doi && (
                  <a
                    href={`https://doi.org/${data.external.doi}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent transition-opacity hover:opacity-80"
                  >
                    DOI ↗
                  </a>
                )}
              </div>
            )}

          {!data.extraction && (
            <p className="mt-10 text-sm text-text-muted">
              No extraction recorded for this paper.
            </p>
          )}

          {data.extraction && (
            <div className="mt-10 space-y-8">
              <Prose label="Problem" value={data.extraction.problem} />
              <Prose label="Prior work" value={data.extraction.priorWork} />
              <Prose label="Method" value={data.extraction.method} />
              <Prose label="Results" value={data.extraction.results} />
              <Prose label="Limitations" value={data.extraction.limitations} />

              {data.extraction.keyTerms &&
                data.extraction.keyTerms.length > 0 && (
                  <section>
                    <SectionLabel>Key terms</SectionLabel>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {data.extraction.keyTerms.map((term) => (
                        <Chip key={term}>{term}</Chip>
                      ))}
                    </div>
                  </section>
                )}

              {data.extraction.datasetsUsed &&
                data.extraction.datasetsUsed.length > 0 && (
                  <section>
                    <SectionLabel>Datasets</SectionLabel>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {data.extraction.datasetsUsed.map((d) => (
                        <Chip key={d}>{d}</Chip>
                      ))}
                    </div>
                  </section>
                )}
            </div>
          )}

          {data.claims.length > 0 && (
            <section className="mt-12">
              <SectionLabel>
                Claims{" "}
                <span className="text-text-muted">({data.claims.length})</span>
              </SectionLabel>
              <div className="mt-4 space-y-3">
                {data.claims.map((claim) => (
                  <ClaimCard key={claim.id} claim={claim} />
                ))}
              </div>
            </section>
          )}

          {libraryId && (
            <ExploreSection
              paperId={id}
              libraryId={libraryId}
              libraryName={libraryName}
              onIngested={onIngested}
            />
          )}
        </article>
      )}
    </motion.div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[13px] font-medium text-text-secondary">{children}</h3>
  );
}

function Prose({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <section>
      <SectionLabel>{label}</SectionLabel>
      <p className="mt-2 text-[15px] leading-[1.65] text-text-primary">
        {value}
      </p>
    </section>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-surface-raised px-3 py-1 text-[13px] text-text-secondary">
      {children}
    </span>
  );
}

function ClaimCard({ claim }: { claim: Claim }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-[15px] leading-[1.6] text-text-primary">{claim.text}</p>
      {claim.sourcePassage && (
        <p className="mt-3 border-l-2 border-border-strong pl-3 text-[13px] leading-relaxed text-text-muted">
          {claim.sourcePassage}
        </p>
      )}
      {claim.confidence && (
        <span className="mt-3 inline-block rounded-full bg-accent-dim px-2.5 py-1 text-[12px] font-medium text-accent">
          {claim.confidence}
        </span>
      )}
    </div>
  );
}

// Lazily-loaded discovery area: authors, references, and citing works from
// OpenAlex. Nothing is fetched until the user expands it.
function ExploreSection({
  paperId,
  libraryId,
  libraryName,
  onIngested,
}: {
  paperId: string;
  libraryId: string;
  libraryName: string;
  onIngested: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ctx, setCtx] = useState<PaperContext | null>(null);
  const [author, setAuthor] = useState<ExternalAuthor | null>(null);

  const expand = () => {
    setOpen((v) => !v);
    if (ctx || loading) return;
    setLoading(true);
    fetch(
      `/api/external/paper-context?paperId=${paperId}&libraryId=${libraryId}`,
    )
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Could not load context.");
        return body as PaperContext;
      })
      .then(setCtx)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  return (
    <section className="mt-12 border-t border-border pt-8">
      <button
        type="button"
        onClick={expand}
        className="text-[13px] font-medium text-accent transition-opacity hover:opacity-80"
      >
        {open ? "Explore ▾" : "Explore references, citations, and author works ▸"}
      </button>

      {open && (
        <div className="mt-5">
          {loading && (
            <p className="flex items-center gap-2 text-[13px] text-text-secondary">
              <Spinner /> loading from OpenAlex…
            </p>
          )}
          {error && <p className="text-[13px] text-[#b4493b]">{error}</p>}
          {ctx && !ctx.available && (
            <p className="text-[13px] text-text-muted">
              External context not available (paper not found in OpenAlex).
            </p>
          )}
          {ctx && ctx.available && (
            <div className="space-y-8">
              <div>
                <SectionLabel>Authors</SectionLabel>
                <div className="mt-2 flex flex-wrap gap-2">
                  {ctx.authors.length === 0 && (
                    <span className="text-[13px] text-text-muted">
                      No author records.
                    </span>
                  )}
                  {ctx.authors.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() =>
                        setAuthor(author?.id === a.id ? null : a)
                      }
                      className={`rounded-full px-2.5 py-1 text-[12px] transition-opacity hover:opacity-80 ${
                        author?.id === a.id
                          ? "bg-accent text-white"
                          : "bg-accent-dim text-accent"
                      }`}
                    >
                      {a.name}
                    </button>
                  ))}
                </div>
                {author && (
                  <AuthorWorksPanel
                    author={author}
                    libraryId={libraryId}
                    libraryName={libraryName}
                    onIngested={onIngested}
                  />
                )}
              </div>

              <CandidateList
                label="Builds on (top references)"
                candidates={ctx.buildsOn}
                libraryId={libraryId}
                libraryName={libraryName}
                onIngested={onIngested}
              />
              <CandidateList
                label="Cited by (most influential)"
                candidates={ctx.citedBy}
                libraryId={libraryId}
                libraryName={libraryName}
                onIngested={onIngested}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function AuthorWorksPanel({
  author,
  libraryId,
  libraryName,
  onIngested,
}: {
  author: ExternalAuthor;
  libraryId: string;
  libraryName: string;
  onIngested: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [works, setWorks] = useState<DiscoveryCandidate[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setWorks(null);
    fetch(
      `/api/external/author-works?authorId=${author.id}&libraryId=${libraryId}`,
    )
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Could not load works.");
        return body.works as DiscoveryCandidate[];
      })
      .then((w) => {
        if (!cancelled) setWorks(w);
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
  }, [author.id, libraryId]);

  return (
    <div className="mt-4 rounded-xl border border-border bg-surface p-4">
      <p className="text-[13px] text-text-secondary">
        Top works by {author.name}
      </p>
      {loading && (
        <p className="mt-2 flex items-center gap-2 text-[13px] text-text-muted">
          <Spinner /> loading…
        </p>
      )}
      {error && <p className="mt-2 text-[13px] text-[#b4493b]">{error}</p>}
      {works && (
        <div className="mt-3 space-y-2">
          {works.map((c) => (
            <CandidateRow
              key={c.openalexId}
              candidate={c}
              libraryId={libraryId}
              libraryName={libraryName}
              onIngested={onIngested}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CandidateList({
  label,
  candidates,
  libraryId,
  libraryName,
  onIngested,
}: {
  label: string;
  candidates: DiscoveryCandidate[];
  libraryId: string;
  libraryName: string;
  onIngested: () => void;
}) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      {candidates.length === 0 ? (
        <p className="mt-2 text-[13px] text-text-muted">None found.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {candidates.map((c) => (
            <CandidateRow
              key={c.openalexId}
              candidate={c}
              libraryId={libraryId}
              libraryName={libraryName}
              onIngested={onIngested}
            />
          ))}
        </div>
      )}
    </div>
  );
}

