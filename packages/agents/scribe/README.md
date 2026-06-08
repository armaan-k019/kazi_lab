# Scribe

The Scribe is the knowledge layer of kazi-lab. It ingests sources, extracts structured fields, and builds the accumulated corpus that other agents read from. See docs/architecture.md for the full system.

## What it does

Given any URL, the Scribe detects the source type and dispatches to the right handler (`src/fetch-source.ts`), then extracts structured fields with Claude and writes everything to Postgres in a single transaction (`papers`, `extractions`, `authors`, `paper_authors`, `claims`).

Three source types are supported:

1. **arXiv** (an arxiv.org URL or a bare arXiv id) — the highest-quality path. Title, authors, abstract, and published date come from the arXiv API (`metadataConfidence: "high"`). Unchanged from earlier versions.
2. **PDF** (a `.pdf` URL, or any URL whose `Content-Type` is `application/pdf`) — text is extracted with `pdf-parse`. There is no metadata API, so Claude infers the title, authors, and published date from the content (`metadataConfidence: "inferred"`).
3. **HTML** (anything else that returns HTML) — the main article content is extracted with `@mozilla/readability` + `jsdom` (nav/ads/boilerplate stripped), with a tag-strip fallback. Metadata is inferred by Claude, same as PDF.

All handlers return the same `SourcePaperData` shape, so the extractor and ingest logic are uniform across sources. For non-arXiv sources, `raw_text` is capped at the first ~40,000 characters to control token cost (see `RAW_TEXT_CAP` in `src/types.ts`).

## Ingesting a source

Set `DATABASE_URL` and `ANTHROPIC_API_KEY` in `.env.local` at the repo root, then:

```
pnpm --filter @kazi-lab/scribe ingest <url>
```

Examples:

```
pnpm --filter @kazi-lab/scribe ingest https://arxiv.org/abs/2312.00738
pnpm --filter @kazi-lab/scribe ingest https://bitcoin.org/bitcoin.pdf
pnpm --filter @kazi-lab/scribe ingest https://en.wikipedia.org/wiki/Cluster_analysis
```

Dedup is keyed by `arxiv_id` for arXiv sources and by the canonical `url` for everything else; re-ingesting a known source is a no-op.

## Current limitations

- No OCR. Scanned or image-only PDFs (little/no extractable text) are rejected with a clear error.
- JavaScript-rendered pages may not extract (the fetcher does not run a browser); such pages can yield little content and are rejected.
- Paywalled or login-gated content is unsupported.
- Inferred metadata (PDF/HTML title, authors, date) is best-effort and can be wrong or empty; arXiv metadata is authoritative.
- No citation parsing yet (the `citations` table is not populated).

## The extraction prompt and versioning

The extraction system prompts live in [src/extractor.ts](src/extractor.ts), along with the `EXTRACTION_VERSION` constant (currently `v3-2026-06-08`). There are two prompts: one for arXiv (metadata known) and one for inferred sources (Claude also returns `inferred_metadata`). Every extraction row records the version that produced it. When you change a prompt, bump `EXTRACTION_VERSION` (use the `vN-YYYY-MM-DD` format) so stored extractions stay traceable to the prompt that generated them.
