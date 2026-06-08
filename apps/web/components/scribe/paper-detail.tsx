"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { Claim, PaperDetail as PaperDetailData } from "@/lib/types";
import { formatPublished, formatTimestamp } from "@/lib/format";

type Props = {
  id: string;
  onBack: () => void;
};

export function PaperDetail({ id, onBack }: Props) {
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
