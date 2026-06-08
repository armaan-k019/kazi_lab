# Scribe

The Scribe is the knowledge layer of kazi-lab. It ingests papers, extracts structured fields, and builds the accumulated corpus that other agents read from. See docs/architecture.md for the full system.

## What it does (v1)

Given an arXiv URL, the Scribe:

1. Fetches paper metadata (title, authors, abstract, published date, URLs) from the arXiv API.
2. Extracts structured fields with Claude: problem, prior work, method, results, limitations, key terms, datasets, and a set of atomic claims (each with its source passage and the paper's hedging language).
3. Writes everything to the Postgres database in a single transaction: `papers`, `extractions`, `authors`, `paper_authors`, and `claims`.

## Ingesting a paper

Set `DATABASE_URL` and `ANTHROPIC_API_KEY` in `.env.local` at the repo root, then:

```
pnpm --filter @kazi-lab/scribe ingest https://arxiv.org/abs/2312.00738
```

Accepted input formats: full abs or pdf URLs (with or without protocol or version suffix) and bare ids (e.g. `2312.00738`). Re-ingesting a paper already in the corpus is a no-op (it is skipped, keyed by `arxiv_id`).

## Current limitations

- arXiv only. Other sources (direct PDFs, DOIs, web pages) are not supported yet.
- No full PDF text extraction. `raw_text` is the title plus abstract; full body text is a v2 improvement.
- No citation parsing. The `citations` table is not populated yet (requires parsing references from the PDF).
- No chat interface, semantic search, or cross-paper reasoning. Those come later.

## The extraction prompt and versioning

The extraction system prompt lives in [src/extractor.ts](src/extractor.ts), along with the `EXTRACTION_VERSION` constant (currently `v1-2026-06-07`). Every extraction row records the version that produced it. When you change the prompt, bump `EXTRACTION_VERSION` (use the `vN-YYYY-MM-DD` format) so stored extractions remain traceable to the prompt that generated them.
