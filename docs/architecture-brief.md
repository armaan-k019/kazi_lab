# kazi-lab Architecture Brief

Interview-prep brief derived from the actual code in this repo. Every constant, model id, prompt, table, and threshold below was read from the real files (paths cited). Where the code differs from the stated conventions or a likely mental model, it is flagged with **[Reality check]**.

Generated 2026-06-10. Reflects the tree at that time.

---

## 0. One-paragraph thesis

kazi-lab is a research-lab monorepo whose product is a **grounded research corpus**: you paste any paper URL, it is fetched, extracted into atomic claims, embedded, and resolved to an external identity (OpenAlex); a library of such papers can be **synthesized** (Opus finds cross-paper themes, findings, claim-level supports/contradicts/extends relations, and open questions) and then **queried** by a chatbot that answers only from retrieved corpus material (refusing when the library does not cover the question) and **extended** by a discovery layer that mines OpenAlex for what the library is missing. The architectural spine is the database: agents integrate through shared Postgres state, not direct calls, and every output traces back to its inputs (provenance). The anti-wrapper test (CLAUDE.md TIER 5) is met on at least four axes: accumulated state (corpus, embeddings, synthesis runs that version over time), real computation beyond the LLM (pgvector HNSW search, OpenAlex citation-graph intersection, Jaccard match scoring, d3-force layout), cross-context value (synthesis output feeds the chat, the graph, and discovery; stored OpenAlex IDs feed gap-finding without refetch), and verification/provenance (every claim links to a paper, every synthesis row to a run, every chat answer to cited chunks).

---

## 1. System overview

### 1.1 Monorepo layout

pnpm workspaces (`pnpm-workspace.yaml`), packageManager pinned to `pnpm@11.5.2` via `devEngines`, with `allowBuilds: [esbuild, sharp, unrs-resolver]`. Workspace globs: `apps/*`, `packages/*`, `packages/agents/*`.

- **`packages/db`** (`@kazi-lab/db`) — the substrate. Drizzle schema (`packages/db/schema.ts`), the single pg `Pool` + Drizzle client (`packages/db/index.ts`), and the migration history (`packages/db/drizzle/*.sql`). Owns: the data model and the one DB connection. Exports the schema and a `db` handle that every other package imports.
- **`packages/agents/scribe`** (`@kazi-lab/scribe`) — all the intelligence. Ingestion, extraction, embedding, synthesis, narration, retrieval, OpenAlex client, external resolution/enrichment, gaps, question-search. Pure TypeScript library plus four CLIs (`ingest`, `synthesize`, `embed-backfill`, `enrich-backfill`). Owns: every Claude/Voyage/OpenAlex call and every write to the synthesis/embedding/external tables.
- **`apps/web`** (Next.js 16 App Router) — the Office UI plus the API routes. Routes are thin: they validate input, call a `@kazi-lab/scribe` function or query the DB, and shape JSON. Owns: HTTP surface, the React UI, and the fire-and-forget orchestration of synthesis. `next.config.ts` sets `transpilePackages: ["@kazi-lab/db", "@kazi-lab/scribe"]` (workspace TS) and `serverExternalPackages: ["pg", "pdf-parse", "jsdom"]` (native/dynamic-require deps kept out of the bundle).

**Dependency direction:** `apps/web` → `@kazi-lab/scribe` → `@kazi-lab/db`. Agents never import each other (there is only one agent, Scribe, by design; TIER 4 says agents integrate through DB state). The web app also imports `@kazi-lab/db` directly for read queries in routes.

**[Reality check] Stack drift vs CLAUDE.md.** TIER 9 says "Next.js 14+"; the lockfile is `next@16.2.7`, `react@19.2.4`. `apps/web/AGENTS.md` explicitly warns that this Next.js has breaking changes and to read `node_modules/next/dist/docs/` rather than trust training data. TIER 10 says "Dark mode default… monospace for technical"; the implemented UI is the **warm/light/green** aesthetic (the terminal look was restyled away). TIER 9 lists Vitest, but there are **no test files** in the tree. Good things to pre-empt in an interview: "the conventions doc is partly aspirational/stale; here is what the code actually is."

### 1.2 End-to-end data flow ("paste a URL" to answer/synthesis/discovery)

Ingestion (single path, `POST /api/scribe/ingest` → `ingestPaper(url, libraryId?)` in `packages/agents/scribe/src/ingest.ts`):

1. `fetchSource(url)` (`fetch-source.ts`) routes to one of `fetchArxivPaper` / `fetchPdfPaper` / `fetchHtmlPaper` and returns a `SourcePaperData` (`types.ts`).
2. Dedup: if an arXiv paper's `arxivId` (or a PDF/HTML paper's `url`) already exists in `papers`, link it into `paper_libraries` and return early with `linkedExisting: true` (no re-extract/embed/enrich).
3. `extractPaperFields(paper)` (`extractor.ts`) calls Claude **Sonnet** to produce structured fields + 3-8 atomic claims (and inferred title/authors/date for PDF/HTML).
4. A single DB transaction writes `papers`, `extractions`, `authors` (+ `paper_authors`), `claims`, and the `paper_libraries` link.
5. **Non-fatal** post-transaction: `embedAndStorePaper` (Voyage embeddings of each claim + a paper summary) and `enrichPaperExternal` (OpenAlex resolution into `paper_external`). Either can fail without failing ingestion; both are backfillable.

Synthesis (`POST /api/synthesis/run` → fire-and-forget): `createSynthesisRun(libraryId)` validates >= 2 papers and inserts a `synthesis_runs` row (status `running`); `void runSynthesis(runId)` runs the heavy **Opus** call, writes themes/findings/relations/open-questions in a transaction, marks the run `completed`, then generates per-paper narrations (**Sonnet**, non-fatal). The UI polls `GET /api/synthesis/status?runId=` every 2.5s; results come from `GET /api/synthesis/results?libraryId=`.

Grounded chat (`POST /api/chat`): `retrieveRelevant({query, libraryId, limit: 12})` embeds the question (Voyage, `input_type: "query"`) and does a library-scoped cosine search over `embeddings`; if the top similarity `< 0.45` it **refuses deterministically with no model call**; otherwise Claude **Sonnet** answers using only the retrieved chunks and returns `{answer, citations, usedChunks, refused}`.

Discovery (read-only OpenAlex): per-paper context (`/api/external/paper-context`), author works (`/api/external/author-works`), library gaps (`/api/external/gaps` → `findLibraryGaps`), and open-question literature search (`/api/external/question-search` → `searchForOpenQuestion`). Each returns ingestable candidates; clicking "ingest" re-enters `POST /api/scribe/ingest`, so a suggestion becomes fully grounded corpus data.

---

## 2. Data model

Source: `packages/db/schema.ts`. 16 tables. Postgres on Neon, accessed via node-postgres `Pool` + Drizzle (`packages/db/index.ts`). pgvector extension enabled in migration 0005.

`packages/db/index.ts` loads the repo-root `.env.local` (existing `process.env` wins, so deployment env overrides the file), throws if `DATABASE_URL` is missing, and registers `pool.on("error", …)` so Neon dropping an idle pooled connection logs instead of crashing the process (a real bug fixed during seeding).

Exported constant: `EMBEDDING_DIM = 1024` (must match voyage-3.5-lite's output dimension exactly, or vector inserts fail).

### 2.1 Ingestion / corpus tables

| Table | Key columns | Relationships | Why it exists / invariant |
|---|---|---|---|
| `papers` | `id`, `arxiv_id` (unique), `title`, `authors text[]`, `abstract`, `published_at`, `url`, `pdf_url`, `raw_text`, `ingested_at`, `last_processed_at` | root | One row per ingested work. `arxiv_id` unique + `url` are the dedup keys. `authors` is denormalized here and also normalized via `authors`/`paper_authors`. |
| `extractions` | `paper_id`, `extraction_version`, `problem`, `prior_work`, `method`, `results`, `limitations`, `key_terms text[]`, `datasets_used text[]` | FK `paper_id` → papers (cascade) | The structured read of a paper, versioned by `extraction_version` so re-extraction is traceable. |
| `claims` | `paper_id`, `text`, `source_passage`, `confidence` | FK `paper_id` → papers (cascade) | Atomic, falsifiable assertions. The unit of provenance: synthesis relations and embeddings both key off claim ids. |
| `authors` | `id`, `name`, `affiliation` | — | Normalized author identity (deduped by name lookup at ingest). |
| `paper_authors` | PK `(paper_id, author_id)`, `position` | FKs → papers, authors (both cascade) | Many-to-many paper↔author with ordering. |
| `citations` | `citing_paper_id`, `cited_paper_id` (nullable), `cited_title`, `cited_arxiv_id`, `context` | `citing` → papers (cascade), `cited` → papers (**set null**) | Internal citation edges; `cited` is set-null so deleting a cited paper does not delete the citation record. (Scaffolded; not the OpenAlex graph.) |
| `annotations` | `paper_id?`, `claim_id?`, `text` | FKs → papers, claims (cascade) | Human notes on a paper or claim. Scaffolded for future use. |

### 2.2 Library tables

| Table | Key columns | Relationships | Why / invariant |
|---|---|---|---|
| `libraries` | `id`, `name`, `description` | — | Named collections. "general" is special: undeletable (enforced in the route, not the schema). |
| `paper_libraries` | PK `(paper_id, library_id)`, `added_at` | FKs → papers, libraries (cascade) | Many-to-many membership. A paper lives in the corpus once and is *linked* into N libraries; deleting a library removes links only, not papers. |

### 2.3 Synthesis tables (all keyed to a run for versioning)

| Table | Key columns | Relationships | Why / invariant |
|---|---|---|---|
| `synthesis_runs` | `id`, `library_id?`, `started_at`, `completed_at`, `status` ('running'\|'completed'\|'failed'), `paper_count`, `model`, `error`, `notes` | FK `library_id` → libraries (cascade) | One row per synthesis attempt. Everything below points back here, so a library can be re-synthesized and old results stay coherent. `library_id` nullable = legacy whole-corpus runs. |
| `themes` | `name`, `description`, `synthesis_run_id` | FK → runs (cascade) | Recurring topics for a run. |
| `paper_themes` | PK `(paper_id, theme_id)`, `relevance` | FKs → papers, themes (cascade) | Which papers belong to a theme. |
| `findings` | `statement`, `detail`, `consensus` ('consensus'\|'contested'\|'single-source'), `synthesis_run_id` | FK → runs (cascade) | Cross-paper insights with a support level. |
| `finding_papers` | PK `(finding_id, paper_id)`, `supporting_claim_id?` | FKs → findings, papers (cascade), claim (**set null**) | Which papers/claims support a finding (provenance for each finding). |
| `claim_relations` | `from_claim_id`, `to_claim_id`, `relation_type` ('supports'\|'contradicts'\|'extends'), `rationale`, `synthesis_run_id` | FKs → claims, runs (cascade) | The cross-paper claim graph. Invariant enforced in code: from≠to, both ids valid, and the two claims must come from **different** papers. |
| `open_questions` | `question`, `rationale`, `related_paper_ids uuid[]`, `synthesis_run_id`, `library_id` | FKs → runs, libraries (cascade) | Gaps the corpus raises but does not answer. Feeds Feature 7 (literature search). |
| `paper_narrations` | `synthesis_run_id`, `paper_id`, `narration` | FKs → runs, papers (cascade) | Precomputed per-(paper, run) positioning paragraph. Supplementary; a run is usable without it. |

### 2.4 Embedding + external tables

| Table | Key columns | Relationships / indexes | Why / invariant |
|---|---|---|---|
| `embeddings` | `entity_type` ('claim'\|'paper'), `entity_id`, `paper_id`, `embedding vector(1024)`, `model`, `content`, `created_at` | FK `paper_id` → papers (cascade); **unique `(entity_type, entity_id)`**; **HNSW index `vector_cosine_ops`** | Vectors for claims and paper summaries. `paper_id` is always the owning paper so retrieval can library-scope via `paper_libraries`. `content` stores the exact embedded text (debuggable, re-rankable). Unique key makes re-embedding an upsert, not a duplicate. |
| `paper_external` | `paper_id`, `source` ('openalex'), `openalex_id`, `doi`, `cited_by_count`, `venue`, `authoritative_title`, `authoritative_year`, `match_status` ('matched'\|'ambiguous'\|'unmatched'), `match_score numeric`, `author_openalex_ids text[]`, `created_at`, `updated_at` | FK `paper_id` → papers (cascade); **unique `(paper_id, source)`** | External identity/enrichment as a discovery layer, not first-class corpus data. Stored `author_openalex_ids` let the author-works feature run without a refetch. |

### 2.5 Migration history (`packages/db/drizzle/`)

`0000_futuristic_morlocks` (core ingestion) → `0001_minor_amazoness` (synthesis v1) → `0002_exotic_red_hulk` (libraries + `synthesis_runs.library_id`) → `0003_adorable_peter_parker` (open_questions + findings.consensus) → `0004_salty_annihilus` (paper_narrations) → `0005_redundant_namora` (pgvector extension + embeddings + HNSW) → `0006_messy_next_avengers` (paper_external). Migration 0005 had `CREATE EXTENSION IF NOT EXISTS vector` prepended by hand because drizzle-kit does not emit it.

**[Reality check] `metadata_confidence` is not a column.** A likely mental model is that papers store a confidence flag. They do not. `metadataConfidence` ('high' | 'inferred') is a transient field on the in-memory `SourcePaperData` (`types.ts`), set 'high' for arXiv and 'inferred' for PDF/HTML, and used at extraction time. At enrichment time the "is this inferred metadata?" decision is **recomputed** as `inferred = !paper.arxivId` (`enrich-store.ts`), not read from a stored column. Cascades are aggressive everywhere (no soft deletes); `raw_text` is uncapped at the DB level but capped to 40k chars at fetch time (§3.1).

---

## 3. The pipeline, stage by stage

### 3.1 Ingestion (routing: arXiv / PDF / HTML)

- **Entry:** `ingestPaper(url, libraryId?)` in `packages/agents/scribe/src/ingest.ts`, via `POST /api/scribe/ingest` (runtime `nodejs`, `force-dynamic`).
- **Routing:** `fetchSource(url)` (`fetch-source.ts`): `isArxivInput(url)` matches `arxiv.org` or a bare id like `2401.12345v2` → `fetchArxivPaper`; a `.pdf` pathname → `fetchPdfPaper`; otherwise fetch once and branch on `content-type` (`application/pdf` → PDF; `text/html`/xhtml/empty → HTML; else throw "unsupported content type").
- **arXiv** (`arxiv-fetcher.ts`): queries `http://export.arxiv.org/api/query` (parsed with `fast-xml-parser`); retry/backoff of **3s, 9s, 27s** over up to 4 attempts, only on **429/503**; `metadataConfidence: "high"`.
- **PDF** (`pdf-fetcher.ts`): `pdf-parse` v2 `PDFParse` class (`new PDFParse({data}).getText()`); if non-whitespace chars `< MIN_USABLE_CHARS (200)` it throws "Could not extract text from PDF; it may be scanned or image-based" (this is the 422 the UI shows); text capped to `RAW_TEXT_CAP = 40_000`; `metadataConfidence: "inferred"`.
- **HTML** (`html-fetcher.ts`): `@mozilla/readability` + `jsdom`; falls back to stripped `textContent` if Readability yields < 200 chars; same 40k cap; `inferred`.
- **HTTP** (`http.ts`): `FETCH_TIMEOUT_MS = 30_000`, AbortController, a real desktop-ish User-Agent.
- **Writes:** one transaction → `papers`, `extractions`, `authors`+`paper_authors` (deduped by name, zero-indexed `position`), `claims`, `paper_libraries`.
- **Failure handling:** fetch / extraction / transaction are **fatal** (the ingest fails, surfaced as 4xx/5xx by the route: 415 unsupported type, 422 no text, 503 rate-limited, 504 timeout, 502 Claude parse failure). Embedding and enrichment are **non-fatal** (try/catch, logged "… (paper still ingested)"). Rationale: the paper + claims are the valuable durable state; vectors and external IDs are recomputable via the backfill CLIs.

### 3.2 Extraction (Claude)

- **Entry:** `extractPaperFields(paper)` in `extractor.ts`. **Model: `claude-sonnet-4-6`**, `MAX_TOKENS = 4096`. `EXTRACTION_VERSION = "v3-2026-06-08"` (stored on each extraction).
- **Why Sonnet:** extraction is structured reading of one document, not cross-document judgment; Sonnet is cheaper and sufficient. (Opus is reserved for synthesis.)
- **Prompt strategy:** two system prompts. `ARXIV_SYSTEM_PROMPT` extracts the fields directly. `INFERRED_SYSTEM_PROMPT` (for PDF/HTML, which have no reliable metadata) first infers `{title, authors, published_at}` then extracts the same fields. Both share `BASE_FIELDS` (problem, prior_work, method, results, limitations, key_terms 5-15, datasets_used, and **3-8 atomic claims** each with `text` / `source_passage` / `confidence` hedge word). Both end with "Return ONLY valid JSON … no markdown, no commentary" and "Do not hallucinate. If a field isn't determinable, return null or empty."
- **Guards:** `rawText` truncated to 40k before the call; JSON parsed against a `RawExtraction` shape; arXiv keeps its authoritative metadata, PDF/HTML use the inferred block.

### 3.3 Embedding (Voyage)

- **Entry:** `embedAndStorePaper(...)` (`embed-store.ts`) using `embedTexts` / `embedQuery` (`embeddings.ts`). **Model: `voyage-3.5-lite`** (1024-dim), endpoint `https://api.voyageai.com/v1/embeddings`, `BATCH_SIZE = 96`.
- **What:** each claim is embedded as `input_type: "document"`; a paper summary (`buildPaperSummary` concatenates problem + method + results + limitations) is embedded as a 'paper' document. Upsert into `embeddings` on the unique `(entity_type, entity_id)` key (`onConflictDoUpdate` sets `excluded.*`), so re-embedding replaces.
- **document vs query split:** stored content uses `"document"`; search queries use `"query"` (`embedQuery`). Voyage's asymmetric embeddings make this matter for relevance.
- **Failure:** throws clearly if `VOYAGE_API_KEY` missing; on ingest the whole step is non-fatal. **[Rough edge]** no retry/backoff on Voyage 429s — a rate-limited embed just fails and waits for a backfill.

### 3.4 Synthesis (Opus)

- **Entry:** `createSynthesisRun(libraryId)` + `runSynthesis(runId)` in `synthesize.ts`. **Model: `claude-opus-4-6`**, `MAX_TOKENS = 16000`.
- **Why Opus:** synthesis is the judgment-heavy, cross-paper task (clustering themes, deciding consensus vs contested, asserting supports/contradicts/extends between specific claims from different papers). The code comment says exactly this.
- **Validation:** `createSynthesisRun` throws `"Synthesis needs at least 2 papers."` if the library has < 2 (route returns 422). The run row is created `running` up front so the UI can poll.
- **Prompt + JSON contract:** one system prompt requests `themes[]` (name, description, paper_ids), `findings[]` (statement, detail, consensus ∈ {consensus, contested, single-source}, supports[{paper_id, claim_id|null}]), `relations[]` (from_claim_id, to_claim_id, relation_type ∈ {supports, contradicts, extends}, rationale), `open_questions[]` (question, rationale, related_paper_ids). Findings are explicitly "cross-paper insights, not single-paper claims restated."
- **Hallucination guards (the important part):** `validPaperIds = new Set(paperIds)` and `validClaimIds = new Set(allClaims.map(c => c.id))` plus `claimPaper: claimId → paperId`. A relation is written only if `from !== to`, both ids ∈ `validClaimIds`, **and `claimPaper.get(from) !== claimPaper.get(to)`** (no same-paper relations). Rejected relations increment `skippedRelations`, recorded in `synthesis_runs.notes`. Theme/finding/question paper-id references are filtered to `validPaperIds`. This is what keeps the synthesis graph honest even if Opus invents an id.
- **Transaction writes:** `themes`, `paper_themes`, `findings`, `finding_papers`, `claim_relations`, `open_questions`. Then the run is marked `completed` **before** narration runs.
- **Narration (Feature):** after completion, a separate **Sonnet** call (`NARRATION_MODEL = "claude-sonnet-4-6"`, `NARRATION_MAX_TOKENS = 4000`) writes a 2-4 sentence positioning paragraph per paper grounded in the finalized relations, into `paper_narrations`. The prompt forbids restating the abstract and "Never invent relations not present in the data." **Non-fatal:** wrapped in try/catch; on failure the run stays `completed` and `notes` records the error. Rationale: narration is supplementary; the main synthesis is the valuable output.

### 3.5 Retrieval (pgvector)

- **Entry:** `retrieveRelevant({query, libraryId, limit?=12, entityTypes?})` in `retrieve.ts`.
- **What:** `embedQuery(query)` → cosine search. SQL uses Drizzle's `cosineDistance(embeddings.embedding, qvec)`; similarity is `1 - distance`; ordered by **distance ascending** (so the HNSW `vector_cosine_ops` index can serve it). Library scope via `innerJoin(paper_libraries …)`; optional `entity_type` filter. Returns `{entityType, entityId, paperId, paperTitle, content, similarity}` per chunk.
- **Failure:** propagates (the chat route catches it). Library scoping is the security/correctness boundary: a question in library A can only retrieve A's chunks.

### 3.6 Grounded chatbot

- **Entry:** `POST /api/chat` (`apps/web/app/api/chat/route.ts`). `SIMILARITY_FLOOR = 0.45`, `RETRIEVE_LIMIT = 12`, **`MODEL = "claude-sonnet-4-6"`**, `MAX_TOKENS = 1024`, `MAX_HISTORY = 6`.
- **Grounding decision:** retrieve top 12; if `best similarity < 0.45`, **refuse deterministically with no model call** ("This library does not contain material that addresses that. The papers here focus on … {distinct titles}"), `refused: true`. This is the strongest possible guarantee against general-knowledge leakage (the model is never invoked, so it cannot answer from training data). Floor chosen from observed scores (on-topic ~0.47-0.66, off-topic ~0.35).
- **Grounded answer:** if covered, the chunks that cleared the floor become the only sources. System prompt: "Answer the user's question using ONLY the provided source material… Do not use outside knowledge… Cite the specific papers you draw from, by title… If the sources do NOT actually address the question, say clearly that this library does not cover it." Returns `{answer, citations:[{paperId, paperTitle}], usedChunks:[…], refused:false}`. Short rolling history (last 6 turns) supports follow-ups; each answer is freshly retrieved.
- **Why Sonnet:** grounded synthesis over already-retrieved text, not hard judgment.

### 3.7 External / OpenAlex discovery

- **Client** (`openalex.ts`): free, no key, polite pool. `OPENALEX_MAILTO` env or default `kazi-lab@example.com`, `USER_AGENT = "kazi-lab/0.1 (research; OpenAlex enrichment)"`, `TIMEOUT_MS = 20_000`, `BASE = https://api.openalex.org`. Functions: `searchWorkByTitle` (`filter=title.search:`), `getWorkByDoi`, `getWorkByArxivId` (DOI `10.48550/arXiv.{id}`), `getWork` (incl. `referenced_works`), `getWorksByIds` (batch, **chunk 50**, `filter=openalex_id:W|W`), `getCitingWorks` (`filter=cites:&sort=cited_by_count:desc`), `getAuthorWorks` (`filter=author.id:&sort=cited_by_count:desc`), `searchWorks` (`search=` + `filter=from_publication_date:`). arXiv abs URL detected from the DOI `10.48550/arxiv.…` pattern or an `arxiv.org/abs/…` landing URL.
- **Resolution** (`resolve-external.ts`): conservative matching. Thresholds `TITLE_STRONG = 0.82`, `TITLE_WEAK = 0.6`, `AUTHOR_STRONG = 0.5`, `SCORE_MATCH = 0.7`, `SCORE_AMBIGUOUS = 0.5`. Score `= 0.6·titleJaccard + 0.3·authorSurnameOverlap + 0.1·yearScore`. **matched** needs title ≥ 0.82 AND authorOverlap ≥ 0.5 AND score ≥ 0.7, and among verified candidates picks the **highest `cited_by_count`** (so the canonical published record beats the arXiv preprint). **ambiguous** needs title ≥ 0.6 AND authorOverlap > 0 AND score ≥ 0.5. Otherwise **unmatched**. A paper with no authors (e.g. a Wikipedia page) can never clear the author bar → correctly unmatched.
- **Enrichment** (`enrich-store.ts`): `enrichPaperExternal` upserts the `paper_external` row (unique `(paper_id, source)`); and **only for inferred-metadata papers (`!arxivId`) with `match_status === "matched"`** does it improve the `papers` row (title, authors, published_at = Jan 1 of authoritative year). arXiv metadata is never overwritten. Non-fatal on ingest.
- **Candidate shaping** (`external-candidates.ts`): `shapeCandidates` computes `ingestableUrl` (priority: arXiv abs → OA url → pdf url → `https://doi.org/{doi}` → null) and resolves `inCorpus`/`inThisLibrary` by **exact `openalex_id` match** against `paper_external` joined to `paper_libraries`.
- **Feature 3, gaps** (`gaps.ts`): `findLibraryGaps` — for each matched library paper, `getWork` (its references) + `getCitingWorks(…, CITING_PER_PAPER = 25)`; tally external works by how many distinct library papers connect (as `referenced` or `cites`); keep those with **≥ 2** connections; rank by connection count then `cited_by_count`; resolve missing metadata via `getWorksByIds`; return top `TOP_N = 15` with provenance, excluding in-corpus. Graceful `{available:false, reason}` if < 2 matched papers.
- **Feature 7, question search** (`question-search.ts`): `searchForOpenQuestion` — `DISTILL_MODEL = "claude-sonnet-4-6"` turns the question into 3-8 keywords (prompt: "Return ONLY the query string… no explanation, labels, or quotation marks"), falling back to the raw question on any failure; `searchWorks` with `from_publication_date` = `currentYear - RECENT_YEARS (5)`; `SLICE = 12`; excludes in-corpus. Returns `{question, searchQuery, candidates}` so the UI can show what it searched (transparency).

---

## 4. Key technical decisions and trade-offs

1. **Model per task (Sonnet vs Opus).** Extraction, narration, chat, and distillation use `claude-sonnet-4-6`; only synthesis uses `claude-opus-4-6`. Chosen: Opus where cross-paper judgment is the whole point, Sonnet everywhere the model is reading/writing over already-structured material. Alternative: Opus everywhere (better but ~5x cost), or Sonnet everywhere (cheaper, weaker synthesis). Trade-off: cost/quality matched to task difficulty. **[Note]** the code pins the `-6` generation; the running environment's latest is `-8`. Bumping is a one-line change per file but should be re-evaluated, not assumed.
2. **Synthesis stored as linked relational data, not regenerated.** Themes/findings/relations/questions/narrations persist, keyed to a `synthesis_run_id`. Chosen for provenance, instant re-display, the visual graph, and so chat/discovery can reuse it. Alternative: regenerate on view. Trade-off: storage + staleness (a run reflects the corpus *at run time*) vs. speed, consistency, and traceability.
3. **Fire-and-forget background synthesis.** `POST /api/synthesis/run` does `void runSynthesis(runId).catch(...)` and returns `{runId, status:"running"}` immediately; UI polls status. Chosen because it is simple and works on a long-lived Node server (`next dev`/`start`). Alternative: await it (request would exceed timeouts) or a real job queue. **Trade-off / serverless implication:** on a freeze-after-response serverless platform the background work can be killed mid-flight. `maxDuration = 120` on the route is a band-aid. This is the single biggest production gap (§6).
4. **Similarity floor for refusal (0.45), deterministic.** `SIMILARITY_FLOOR = 0.45` in `chat/route.ts`; below it, no model call at all. Chosen for a hard no-leak guarantee. Alternative: always call the model with weak context and instruct it to refuse (nicer prose, small leak risk). Trade-off: canned refusal text vs. zero chance of a general-knowledge answer. The grounding contract is treated as non-negotiable, so determinism won.
5. **Conservative OpenAlex matching.** Thresholds 0.82/0.6/0.5/0.7/0.5 with the `0.6/0.3/0.1` score weighting, requiring author overlap to accept. Chosen because "a wrong match is worse than no match" (it would later pull the wrong author's works). Trade-off: false negatives (e.g. BERT, whose canonical record OpenAlex does not surface under its arXiv DOI, stays unmatched) in exchange for ~zero false positives.
6. **Many-to-many libraries.** A paper is ingested into the corpus once and linked into N libraries via `paper_libraries`; deleting a library removes links only. Chosen so the same paper can sit in multiple reading lists and dedup is global. Trade-off: every library-scoped query needs a join; "delete library" is not "delete papers."
7. **Precomputed narration (Sonnet, at synthesis time).** Rather than per-click generation. Chosen so node clicks are instant and consistent, narration sees finalized relations, and it updates when re-synthesized. Trade-off: stored per (paper, run); a click after a corpus change shows the last run's narration until re-synthesis.
8. **HNSW + cosine index.** `embeddings_hnsw_cos_idx USING hnsw (embedding vector_cosine_ops)`. Chosen: approximate-NN with no training, good at this scale. Alternative: IVFFlat (needs training/tuning) or brute force (fine at dozens, not at scale). Trade-off: approximate recall for speed; at the current corpus size it is effectively exact.
9. **rawText cap (40k chars).** PDF/HTML text is sliced to `RAW_TEXT_CAP = 40_000` before extraction. Chosen to bound token cost and latency. Trade-off: very long papers lose their tail; claims come from the first ~40k chars. The DB column itself is uncapped.
10. **document/query embedding input-type split.** Stored content embedded as `"document"`, queries as `"query"`. Chosen because voyage-3.5-lite is asymmetric. Trade-off: none really; it is the correct usage and materially improves retrieval.
11. **One shared pg Pool with a Neon error listener.** Chosen after a real crash: Neon drops idle connections, which without a listener becomes an unhandled `error` event that kills the process. Trade-off: a logged warning instead of a crash; the pool transparently reconnects.

---

## 5. Edge cases and failure modes (what the code actually handles)

- **Library with < 2 papers:** `createSynthesisRun` throws "Synthesis needs at least 2 papers." → `run` route 422; `findLibraryGaps` returns `{available:false, reason:"Need at least 2 matched papers…"}`; the synthesis-control button is disabled (`paperCount >= 2`).
- **Unmatched-to-OpenAlex paper:** `paper_external.match_status = 'unmatched'`; paper-detail `external` is null (the `[id]` route joins only `match_status = 'matched'`); `/api/external/paper-context` returns `{available:false}`; gaps uses only matched papers.
- **Re-ingest / linked-existing:** dedup by `arxiv_id` or `url`; the existing paper is linked into the target library and the call returns `linkedExisting:true` with no re-extract/embed/enrich; the UI shows "added (already in corpus)."
- **Scanned/empty PDF:** `< 200` non-whitespace chars → thrown error → route 422 "Could not extract text… (scanned, paywalled, or JavaScript-only)." Nothing is written.
- **JS-only / thin HTML:** Readability < 200 chars → stripped-text fallback → if still empty, fails the same way.
- **arXiv rate limit / outage:** 429/503 retried at 3s/9s/27s (4 attempts); persistent failure surfaces as 503.
- **OpenAlex slowness:** 20s timeout per request; discovery routes return 502 on error rather than crash. **No retry.**
- **Invalid/hallucinated claim or paper ids in synthesis:** filtered against `validClaimIds`/`validPaperIds`; same-paper relations rejected; counts recorded in `notes`.
- **Null publication date:** timeline graph places the paper in a separate **undated lane** at `UNDATED_X` with a dashed separator and an "undated" label; the time axis stays meaningful for dated papers.
- **Empty / weak retrieval in chat:** top similarity `< 0.45` → deterministic refusal, `refused:true`, citations empty, but `usedChunks` still returned for transparency.
- **Embedding or enrichment failure at ingest:** non-fatal; the paper + claims persist; recoverable via `embed-backfill` / `enrich-backfill`.
- **Narration failure at synthesis:** non-fatal; run stays `completed`; error in `notes`.
- **Neon idle-connection drop:** `pool.on("error")` logs and the pool reconnects on the next query.
- **"general" library delete:** blocked with 403 in `libraries/[id]`.
- **Contested findings vs contradiction relations:** the synthesis header counts them separately — `findings.consensus === 'contested'` is distinct from `relations.relationType === 'contradicts'` — because a real red contradiction edge in the graph was previously hidden behind "0 contested."

---

## 6. Production-readiness gaps (honest, each grounded in code)

1. **Background work on serverless.** `synthesis/run/route.ts` uses `void runSynthesis(...)`; gap/question routes do many seconds of OpenAlex calls inline. On Vercel-style serverless the function can freeze after the response, killing synthesis mid-write, and long discovery calls can exceed limits. Fix: a durable queue/worker (the `synthesis_runs` table is already a usable job record) and/or streaming. `maxDuration = 120` only narrows the window.
2. **No auth.** Every route under `apps/web/app/api/*` is open; there is no session, ownership, or rate limiting. Anyone who can reach the server can ingest, synthesize, delete libraries, and spend API tokens. Fix: auth + per-user/library ownership + per-route rate limits.
3. **Secrets/env.** Keys (`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `DATABASE_URL`, `OPENALEX_MAILTO`) load from repo-root `.env.local` via `packages/db/index.ts`; presence is checked but nothing rotates or validates them, and the same file feeds both CLIs and the server. Fine for local; production needs a secret manager and per-environment config.
4. **Embedding/OpenAlex rate-limit + cost.** `embeddings.ts` has no retry/backoff (a Voyage 429 just fails); OpenAlex calls have a 20s timeout but no retry and no caching. Backfills (`embed-backfill`, `enrich-backfill`) run sequentially with small sleeps. At volume this needs real rate limiting, retries with jitter, and response caching.
5. **On-demand gap-scan call count.** `findLibraryGaps` issues ~`2N + 1` sequential OpenAlex calls (a `getWork` + `getCitingWorks` per matched paper, plus a batch resolve) with no caching. ~13 calls / a few seconds for 6 papers; it grows linearly and is re-run on every click. Fix: cache per (library, run) with a TTL, or precompute.
6. **Retrieval at scale / context budget.** `retrieveRelevant` fixes `limit = 12` and chat feeds all above-floor chunks into a `MAX_TOKENS = 1024` answer with no reranking and no token-budget trimming. Fine for small libraries; large ones want reranking and a token-aware context builder.
7. **Graph legibility at scale.** `timeline-graph.tsx` forces/thresholds (`MID_MIN 0.75`, `CLOSE_MIN 1.8`, charge −300, W 920 × H 540) are tuned for ~6-15 papers; open-question dashed edges get dense and CLOSE-zoom claim rings overlap beyond that. Constants are centralized for tuning but there is no LOD/clustering for large graphs.
8. **In-corpus matching by exact OpenAlex id.** `shapeCandidates` flags `inCorpus`/`inThisLibrary` by exact `openalex_id`. Because a stored id can be a sibling record of the one in another paper's reference/citation list, this **under-reports** (safe, never a false positive). Fix: also match on DOI / arXiv id.
9. **Observability.** Logging is `console.log/console.error` throughout; no structured logs, metrics, tracing, or error reporting. Synthesis/narration failures only surface in `synthesis_runs.notes`.
10. **No tests.** TIER 9 lists Vitest; there are none. The id-validation guards, matching thresholds, and dedup logic are exactly the kind of pure functions that want unit tests.

---

## 7. "If I had more time" (prioritized, each tied to a real limitation)

1. **Durable job runner for synthesis + gap scans** (replaces §6.1/§6.5): a worker consuming a queue, writing to the existing `synthesis_runs`/a new `gap_runs`, with retries and idempotency. Unblocks serverless deploy.
2. **Auth + ownership + rate limiting** (§6.2): the prerequisite for any multi-user deployment.
3. **Caching + retry/backoff for OpenAlex and Voyage** (§6.4/§6.5): TTL cache on OpenAlex responses, jittered retries, a token-bucket limiter; makes discovery cheap and resilient.
4. **DOI/arXiv-aware in-corpus matching** (§6.8): fixes the citation-graph under-reporting so "in this library" flags are complete.
5. **Token-budgeted retrieval + reranking for chat** (§6.6): a reranker over the top-k and a context builder that fills a token budget instead of a fixed 12.
6. **Tune the question-distillation prompt** (Feature 7 skews to surveys) and the **graph LOD** for larger libraries (§6.7).
7. **Structured observability** (§6.9): request ids, timing, model-call cost logging, and surfacing `synthesis_runs.notes` in the UI.
8. **Unit tests** (§6.10) for `resolve-external` scoring, the synthesis id-guards, `parseUrls`, and `ingestableUrl` priority.
9. **Bump model generation** to the current `-8` Opus/Sonnet and re-validate prompts.
10. **Improve matching recall** for famous papers OpenAlex hides under non-canonical records (the BERT case), e.g. an OpenAlex `search=` fallback when the title filter misses.

---

## 8. Verbal walkthroughs

### 8.1 60-second elevator

> kazi-lab is a grounded research-corpus tool. You paste any paper URL; it routes to an arXiv, PDF, or HTML fetcher, then Claude Sonnet extracts structured fields and atomic claims, which go into Postgres. Claims and a paper summary get embedded with Voyage into pgvector, and the paper is resolved to its OpenAlex identity. The architecture is database-as-substrate: there is one Scribe agent and everything integrates through shared tables, with provenance end to end, so every claim links to a paper and every output links to its inputs. On top of a library of papers you can run synthesis, which is a Claude Opus call that finds cross-paper themes, findings, and claim-level supports/contradicts/extends relations, all stored and versioned by run. Then there is a chatbot that answers only from retrieved corpus chunks and refuses, with no model call at all, when nothing clears a similarity floor, so it cannot leak general knowledge. And there is a discovery layer over OpenAlex that tells you which papers your library is missing and finds recent work on the open questions synthesis surfaced. Anything you discover is one click to ingest, which runs the same pipeline and makes it grounded.

### 8.2 5-minute deep version

> **The shape.** It is a pnpm monorepo: `packages/db` owns the Drizzle schema and the single Postgres connection; `packages/agents/scribe` owns all the intelligence and every external API call; `apps/web` is a Next.js App Router app with thin API routes and the React UI. The guiding principle, from the conventions doc, is database-as-substrate and provenance everywhere.
>
> **Ingestion.** `ingestPaper` in the scribe package. `fetchSource` routes by input: arXiv ids and arxiv.org go to the arXiv API with 3/9/27-second backoff on 429s; `.pdf` or a PDF content-type goes to pdf-parse v2, which throws if it gets under 200 non-whitespace characters so scanned PDFs fail cleanly; everything else goes to Readability over jsdom. Text is capped at 40k chars. Then Claude Sonnet extracts problem/method/results/limitations plus 3-to-8 atomic, falsifiable claims; for PDFs and web pages it also infers title, authors, and date. One transaction writes papers, extraction, authors, claims, and the library link. Two more steps run after and are deliberately non-fatal: Voyage embeddings of the claims and summary, and OpenAlex resolution. If either fails the paper still persists and a backfill CLI can fix it later. Dedup is global: re-ingesting a known paper just links it into the new library.
>
> **Synthesis.** `POST /api/synthesis/run` validates at least two papers, inserts a run row, and fires `runSynthesis` without awaiting, returning a run id the UI polls every 2.5 seconds. The heavy call is Claude Opus, because this is the cross-paper judgment task. The key engineering is the hallucination guards: the model returns claim and paper ids, and the code validates every one against sets of real ids, and specifically refuses any "relation" whose two claims come from the same paper, so the cross-paper graph can't be faked. The run is marked completed before a separate, non-fatal Sonnet pass writes per-paper "narration" paragraphs. Everything is keyed to the run id, so a library can be re-synthesized and old results stay coherent.
>
> **Retrieval and chat.** Embeddings live in a pgvector table with an HNSW cosine index, and every embedding stores its owning paper id so retrieval can scope to a library through the membership join. The chat route retrieves the top 12 chunks for a question; if the best cosine similarity is below 0.45 it returns a refusal with no model call at all, which is the hard guarantee against general-knowledge leakage; otherwise Sonnet answers using only those chunks and returns citations and the chunks it used, so the answer is auditable.
>
> **Discovery.** A live OpenAlex layer, no key, polite pool. Per paper you can see what it builds on and what cites it; per author, their other work; and two library-level features: "what am I missing," which walks every matched paper's references and citers and surfaces external works connected to at least two of your papers, ranked with provenance; and "find recent work," which distills a synthesis open question into keywords with Sonnet and searches the last five years. Matching into the corpus is deliberately conservative, weighted title-Jaccard plus author overlap plus year, so it would rather say "no match" than attach the wrong paper. Every suggestion is one click to ingest through the same pipeline.
>
> **Honesty.** The biggest production gap is that synthesis is fire-and-forget, which is reliable on a long-lived Node server but needs a real queue on serverless. There is no auth yet, OpenAlex and Voyage calls have no caching or retry, the gap scan is about 2N sequential calls per run, in-corpus matching is by exact OpenAlex id so it under-reports safely, logging is just console, and there are no tests. None of those are hard to fix; they are the difference between a working, provenance-clean prototype and a deployed product, and the data model is already shaped to support the fixes.

---

## Appendix: constants quick-reference (for "what's the exact value" questions)

| Thing | Value | File |
|---|---|---|
| Embedding dim | `1024` | `packages/db/schema.ts` (`EMBEDDING_DIM`) |
| Extraction model / version | `claude-sonnet-4-6` / `v3-2026-06-08`, MAX_TOKENS 4096 | `extractor.ts` |
| Synthesis model | `claude-opus-4-6`, MAX_TOKENS 16000 | `synthesize.ts` |
| Narration model | `claude-sonnet-4-6`, MAX_TOKENS 4000 | `synthesize.ts` |
| Embedding model / batch | `voyage-3.5-lite` / 96 | `embeddings.ts` |
| Chat model / floor / limit / history | `claude-sonnet-4-6` / `0.45` / 12 / 6, MAX_TOKENS 1024 | `chat/route.ts` |
| Retrieval default limit | 12 | `retrieve.ts` |
| Raw text cap | 40_000 chars | `types.ts`, pdf/html fetchers |
| PDF min usable chars | 200 | `pdf-fetcher.ts` |
| arXiv backoff | 3s / 9s / 27s, 4 tries, 429/503 | `arxiv-fetcher.ts` |
| HTTP timeout | 30_000 ms | `http.ts` |
| OpenAlex timeout / batch chunk | 20_000 ms / 50 | `openalex.ts` |
| Match thresholds | title 0.82/0.6, author 0.5, score 0.7/0.5; weights 0.6/0.3/0.1 | `resolve-external.ts` |
| Gaps | CITING_PER_PAPER 25, TOP_N 15, ≥2 connections | `gaps.ts` |
| Question search | Sonnet distill, RECENT_YEARS 5, SLICE 12 | `question-search.ts` |
| Batch ingest delay | 5000 ms | `scribe-view.tsx` (`BATCH_DELAY_MS`) |
| Synthesis poll / word cycle | 2500 ms / 5000 ms | `synthesis-control.tsx` |
| Graph zoom thresholds / canvas | MID 0.75, CLOSE 1.8 / 920×540 | `timeline-graph.tsx` |
| synthesis/run maxDuration | 120 | `synthesis/run/route.ts` |
