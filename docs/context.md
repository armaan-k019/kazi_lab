# kazi-lab context and decision log

This is the running decision log for kazi-lab. It replaces docs/project-state.md as
the living record. Any consequential decision (architecture, data, integrations,
scope, deviations) is appended to the Decisions section, newest first, with date,
decision, reasoning, and consequences.

## Project overview (pipeline as it exists now)

kazi-lab is a multi-agent research lab over a corpus of papers. The layers:

- Scribe: per-library synthesis (themes, findings with consensus labels, typed
  claim relations, open questions), plus embeddings and OpenAlex enrichment.
- Critic: per-library adversarial audit of a synthesis run, plus a
  direction-setting abstract with a claim_to_test.
- Cross-domain synthesis: grounded recurrence links across libraries.
- Cross-domain Critic: skeptical validation of links + conservative discovery.
- Experimentalist: deterministic meta-analysis over paper_metrics (pooling math in
  TypeScript, no LLM number) plus a verifiable, execution-ready experiment spec.
- Writer: grounded research documents from an Experimentalist thread (documentarian,
  no new numbers/claims).
- Research Web: a corpus-wide knowledge graph (papers, claims, methods, datasets,
  canonicalized concepts), seeded Louvain communities, Brandes betweenness bridges,
  degree-penalized Swanson ABC discovery, and structure-mapped crossover proposals
  that hand off to the existing cross-domain Critic as candidates.

Discipline (non-negotiable): deterministic math in unit-tested TypeScript; the LLM
labels, proposes, and maps but computes no score and asserts no link; every output
grounds to real nodes with provenance; under-merge over over-merge; prefer emitting
nothing over a stretch; immutable snapshot runs; transactional writes; honest
reporting of thin or failed results. Models come from packages/db/models.ts. No em
dashes anywhere.

## Decisions

### 2026-07-23 Crossover proposal pipeline hardened; root cause was API credit exhaustion
Decision: rebuild proposeCrossovers as an explicitly staged pipeline (select_run,
candidates, grounding_prep, proposer_llm, grounding, persist, auto_critique), each
stage individually guarded, with a diagnostics object returned on every outcome
(completed, nothing, failed) and rendered in a Discovery diagnostics panel.
Reasoning: the "Propose crossovers" failure was diagnosed by direct CLI
reproduction before any code change. The verbatim root cause: the Anthropic API
returned 400 "Your credit balance is too low to access the Anthropic API" at the
proposer LLM call. The route then swallowed it into a generic message. The bug to
fix was opacity, not the billing state: nothing in the pipeline recorded which
stage failed or why. Additional latent issue fixed: no short-circuit existed for
the degenerate case where no candidate has 2+ groundable evidence papers, which
would have burned an LLM call to produce guaranteed-dropped proposals (on the
current corpus only 4/14 candidates are viable; 3 synthesized libraries).
Consequences: empty and degenerate inputs short-circuit honestly WITHOUT an LLM
call; the proposer LLM failure surfaces its real error and stage in the UI;
ConceptNet grounding is best-effort (5s timeout, one retry, records unavailable
and proceeds at low confidence, never blocks); resolveEvidenceRef is guarded so a
throw becomes a droppable result; auto-critique only runs with 1+ links and its
failure never loses persisted proposals; per-service statuses (ConceptNet,
Datamuse, Crossref, Semantic Scholar) are probed informationally and ConceptNet's
is overridden by actual usage. Proposals still require API credits to run; the
pipeline now says so in plain text instead of failing opaquely. Diagnostics are
returned per-response and rendered client-side, not persisted (no migration; a
zero-proposal run creates no row to attach them to, and the run-level outcome is
already recorded on cross_domain_runs when links persist).

### 2026-07-23 Projection parameters chosen by computed silhouette, not by eye
Decision: build-web now sweeps t-SNE parameters (perplexity 10/20/30/45 clamped to
the (n-1)/3 well-posedness cap, early exaggeration 4/12) and selects the setting
maximizing the mean silhouette score of the Louvain communities in the 3D
coordinates. The full sweep with metrics is stored in stats.projectionSweep and
the chosen setting on the run's params (jsonb, no migration). Unit-tested
(silhouette correctness, determinism, cap clamping); seeded reproducibility kept.
Reasoning: the prior fixed default (perplexity 30, early exaggeration 12) produced
visibly intermingled clusters. On the real 107-paper corpus the sweep measured:
silhouette 0.2712 for the stored default coords versus 0.4155 for perplexity 10 +
early exaggeration 4 (intra/inter distance ratio 0.5837 vs 0.4304). The choice is
now evidence-based and auditable per run. UMAP was NOT added: no UMAP dependency
exists in the repo, hand-rolling was ruled out by the prompt, and adding a
marginally-maintained new library (umap-js) was not justified; tuned t-SNE stays.
Consequences: the CURRENT stored run still has the old coordinates (rebuilding was
deliberately skipped: community labels come from an LLM call that degrades to
unlabeled without API credits, and losing the 5 real labels for a cosmetic-only
rebuild was a bad trade). The next "Rebuild web" after credits are restored will
self-tune, store the sweep, and re-label.

### 2026-07-23 3D web rewritten as an instrument: additive sprites, staged edges, ego networks
Decision: web-graph-3d.tsx rewritten. Points are soft additive-blended radial
sprites (custom ShaderMaterial, size by influence with clamps, community-colored
from a documented desaturated palette, manual FogExp2 in-shader). Edges default ON
in two classes: intra-community (faint, community-hued, top-4 strongest per node)
and inter-community bridges (brighter, warm, gentle bezier arcs), capped at 3000
drawn edges selected by weight, plus a bridges-only toggle. Communities get
billboarded centroid labels (CanvasTexture sprites that fade when the camera is
near) and soft halo sprites at centroids scaled to member RMS extent. Interaction:
damped orbit, idle auto-rotation (eases in after 5s, stops instantly on input),
throttled raycast hover with tooltip (title, community, influence), click-to-ego-
network with dimming and desaturation of non-members, shift-click or button to
expand one hop, camera easing to selection, interactive legend (hover highlights,
click isolates and frames), reset view, prefers-reduced-motion respected. Post:
EffectComposer with subtle UnrealBloomPass (0.5/0.55/0.6) and a DOM vignette.
Reasoning: the data already contained the structure; the render did not express
it. The halo sprite was chosen over a convex hull because it is one draw call per
community and reads clearly at this corpus size. Ego adjacency uses the DRAWN
edge set so highlights always correspond to visible edges. A dev-only
window.__measureWebGraph probe (guarded by NODE_ENV) measures synchronous render
cost; measured 3.85 ms/frame with forced GPU flush at 107 nodes + 447 edges
(about 260 FPS implied), so 500+ nodes has ample headroom.
Consequences: pixel ratio capped at 2; all geometries, materials, textures,
passes, composer, controls, listeners, and the RAF loop are disposed on unmount
(verified: no WebGL context warnings across repeated HMR remounts); container
resize handled via ResizeObserver. A .claude/launch.json was added so the app can
be previewed by name; it is dev tooling, flagged for review.

### 2026-07-23 Execution notes and deviations (this prompt)
Decision: build all non-destructive infrastructure first and defer the irreversible
corpus reset + multi-hour reseed to a deliberate later step (the human chose this
sequencing when asked).
Reasoning: the full reseed (15 seeds + citation-graph expansion) is hours of
ingestion that cannot complete atomically in one turn; firing the irreversible
reset without being able to reseed would leave the lab empty.
Consequences: the reset CLI is built and guarded (RESET_CONFIRM=1) but NOT run; the
seed/expansion is NOT run yet. Everything else was demonstrated non-destructively on
the CURRENT corpus (107 papers). The citations backfill and web build ran on that
corpus. The citations backfill is real and working (cites edges > 0) but keyless
Semantic Scholar is heavily rate-limited, so the full pass is slow and was reported
at whatever it had committed at build time (it commits per paper, idempotently).

### 2026-07-23 Creativity comes from structure, not instructions
Decision: never add "be creative/bold/imaginative" language to any system prompt.
Reasoning: genuinely non-obvious cross-domain discovery is produced by mechanism, not
mood. The mechanisms are: forcing candidate bridges to span semantically DISTANT
communities (domain-distance factor), grounding analogies in ConceptNet's real
relation graph, and requiring explicit structure-mapping (relational correspondence,
not surface vocabulary). Any proposal that cannot state its relational mapping and
cite evidence on both sides is not emitted.
Consequences: novelty is auditable and grounded; flourish is allowed only in
presentation (a label, an epigraph) where it does not alter or inflate content.

### 2026-07-23 Corpus reset behind a guarded, irreversible CLI
Decision: provide a single transactional reset routine that deletes all libraries,
papers, and every dependent row, guarded by RESET_CONFIRM=1, and verifies zero rows
remain. Schema and code are preserved; the libraries feature stays intact; no default
general library is recreated (the web is the substrate now).
Reasoning: a deliberately diverse seeded corpus needs a clean slate, and a destructive
reset must never fire accidentally.
Consequences: irreversible. Sequencing note (this prompt): the human chose to build
all non-destructive infrastructure first and run the reset + reseed as a deliberate,
separate step, because the full reseed (15 seeds + citation-graph expansion) is hours
of ingestion that cannot complete atomically in one turn.

### 2026-07-23 Diverse seed corpus + Semantic Scholar citation-graph expansion
Decision: seed with 15 verified landmark papers spread across distant fields
(transformers, ResNet, NeRF, PointNet, network science, quantitative biology, Higgs,
LIGO, halo finding, DreamFusion, BERT, GPT-3, normalizing flows, graph networks), all
ingested corpus-only (no library). Expand via Semantic Scholar references/citations,
selecting by a documented deterministic rule: prefer influential links, prefer papers
whose fieldsOfStudy differ from the seed (maximizing domain diversity), cap per-seed
and overall, dedupe, require an accessible source or skip.
Reasoning: real cross-domain distance is what the discovery layer needs to bridge; the
citation graph grows the corpus without inventing ids.
Consequences: corpus quality (and thus every downstream result) depends on honest
skip-and-report; never invent a paper id.

### 2026-07-23 Two-tab information architecture: RESEARCH and DISCOVERY
Decision: restructure the top-level UI into exactly two primary tabs. RESEARCH holds
the four agents (Scribe, Critic, Experimentalist, Writer) plus optional library
management, reachable via secondary nav. DISCOVERY holds the Research Web (3D), the
emergent communities, bridges, ABC chains, crossover proposals with verdicts, and the
sanity stats. Default landing is DISCOVERY.
Reasoning: the two mental modes (working a project vs exploring the corpus-wide web)
deserve distinct top-level homes; the web is now the substrate.
Consequences: a reorganization, not a removal; every existing view stays reachable.

### 2026-07-23 The web is a 3D t-SNE visualization
Decision: project the existing Voyage 1024-dim paper embeddings to 3D with a seeded,
unit-tested Barnes-Hut t-SNE (documented constants: perplexity scaled to corpus size,
theta 0.5, early exaggeration, fixed iterations), persist the coordinates on the web
run, and render with three.js (community color, influence size, bridge emphasis, edge
toggle, orbit controls). UMAP is not hand-rolled.
Reasoning: 3D structure over the real embeddings makes emergent domains and bridges
legible; determinism keeps the view stable and the projection auditable.
Consequences: a new migration for coordinates; three.js added as a dependency.

### 2026-07-23 External integrations: Semantic Scholar, ConceptNet, Datamuse, Crossref
Decision: add four keyless-capable, non-fatal, honestly-degrading clients. Semantic
Scholar populates the citations table (fixing the empty cites edges) with influence
flags and fieldsOfStudy. ConceptNet grounds proposed analogies in a real relation
graph (recorded, feeds confidence; absence lowers confidence, never auto-rejects).
Datamuse only canonicalizes/expands concept labels (never creates edges). Crossref
supplies DOI metadata/references where Semantic Scholar misses.
Reasoning: real citation edges and a real semantic relation graph make discovery
grounded rather than vocabulary-driven.
Consequences: env placeholders added (empty); every client logs and degrades on
failure; ConceptNet responses are cached.

### 2026-07-23 IDF down-weighting + domain-distance factor (discovery sharpening)
Decision: weight concept-sharing projection edges by inverse document frequency so
ubiquitous concepts contribute little and rare shared concepts contribute a lot; and
add a domain-distance factor to ABC/bridge ranking so candidates spanning
low-similarity (distant) communities score higher.
Reasoning: the prior build had ~96% projection pair-density and off-topic papers did
not isolate; IDF should reduce spurious density. Distance-forcing is the mechanism
that produces surprise (real links between distant fields, not near-neighbors).
Consequences: projection density, modularity, and the orphan check are re-reported
before/after; honest about whether IDF fixed the density problem.

## Standing conventions

- docs/context.md is updated with any consequential decision in future prompts
  (architecture, data, integrations, scope, deviations). Newest entry first.
