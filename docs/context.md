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

## Autonomous Scheduler (Phase 1)

The scheduler is the lab detecting what to do. One detection pass is an
immutable snapshot (scheduler_runs + scheduler_tasks + scheduler_diagnostics,
transactional): deterministic TypeScript reads the corpus state and queues
actionable tasks with conservative cost estimates. No LLM is involved in
detection; the scheduler proposes and the human approves every consequential
move. Phase 1 is on-demand (a "Run detection now" button and a CLI); there is
no daemon. SCHEDULER_INTERVAL_MINUTES documents the intended cadence for the
future daemon and is advisory today.

Detection rules (detectStaleStates, unit-tested, thresholdDays default 30):
- stale synthesis (priority 5): latest completed synthesis older than the
  threshold AND (papers added since, or the last attempt errored). A library
  with papers and NO synthesis ever is also queued here (maximally stale).
- missing metrics (priority 6): papers with key_terms exist but zero
  paper_metrics rows for the library. Auto-approved (idempotent, only-missing).
- missing cross-domain (priority 7): some synthesized library is uncovered by
  the latest completed cross-domain run, or that run is older than the
  threshold. One corpus-level task, not one per library.
- missing proposals (priority 8): the latest cross-domain run has zero links
  or every link was rejected by its critique.
- api failures (diagnostic only): failed agent runs in the last 24h are
  recorded; no retry task is queued in Phase 1 (human judgment).

Approval workflow: extract_metrics is auto-approved (low-risk, idempotent,
cost-capped); re_synthesize, re_critique, extract_cross_domain, and
propose_crossovers require a human Approve. Defer and Reject are recorded
states, not deletions. Execution wraps the existing agent CLIs as child
processes (database-as-substrate: the scheduler never imports agent logic),
sequentially with 5s spacing, per-task timeouts, and per-task transactional
status updates. Completed agent work is never rolled back by a later task
failure; the honest record is per-task status plus run counters.

Cost estimates are conservative upper bounds from the prompt (~$0.30 per
metrics library capped at $5 total, ~$2 per synthesis, ~$3 per cross-domain
run, ~$1 per proposal run), stored per task and never asserted as precise.

## Decisions

### 2026-08-19 Visual redesign: clouds to atmosphere, arrows to a shader cue, bot to a character
Decision: a pure visual-quality pass on the 3D web and the SchedulerBot after
the human judged the first render bad. Deleted outright (not flagged off):
the octahedron community clouds and the instanced cone bridge arrows.
Replaced with: (1) layered cloud sprites, 4 soft radial-gradient billboards
per community (20 total at 5 communities), jittered deterministically from
the community index, additive at 0.06 per-sprite opacity, drifting 1 to 2
percent on 8 to 15s phase-offset periods, fading 600ms on toggle, still
default ON; (2) a bridge direction cue as a brightness gradient along the
line itself (aGrad vertex attribute oriented lower-degree to higher-degree,
shader mix dim 0.55 to bright 1.45), default OFF, no geometry; bridge base
alpha cut 0.42 to 0.34 so bridges sit calmly over the soft clouds. The bot
was rebuilt as a plush penguin-blob: lathe egg body (wider bottom third,
soft seat), vertex-color white face-and-belly panel over leafy green
(#4fb585 default), flippers, feet nubs, one antenna, large low-set
rounded-rect eyes with highlight dots, beak or mouth behind FACE_STYLE,
blush cheeks, soft/toon material behind MATERIAL_STYLE, its own 3-light rig,
a ground shadow that widens on squash, and squash-and-stretch animation for
all five states (loading is a bounce, not a spin; error deflates under a
little cloud, no shaking). /bot-test became the tuning cockpit (state
buttons, face/material/cheek toggles, sliders for green hex, belly
coverage, eye size and height, bounce amplitude, breathing speed, applied
live through a tuning prop with no scene rebuild); the web view gained a
dev-only tuning row (cloud opacity, cloud scale, bridge opacity multipliers)
rendered only in development builds.
Reasoning: octahedra read as collision meshes and occluded papers; cones
turned the graph center into noise; the sphere bot had no character. Craft
constraints applied throughout: no hard edges, everything eased, clouds must
frame papers rather than cover them (per-sprite opacity capped at the 0.04
to 0.08 band).
Consequences: Claude Code cannot see renders, so final tuning is explicitly
the human's, on /bot-test and the dev tuning row; keeper values get baked
into BOT_DEFAULTS and the cloud constants. Frame cost could not be measured
headlessly; the __measureWebGraph() console probe remains the tool. Known
issue carried forward, out of scope here: executeApprovedTasks has no
concurrency guard, and an overlapping CLI + UI execution of run b330c73d
double-ran tasks (generative-3d also extracted zero rows in 40s and needs
its own diagnosis).

### 2026-08-18 Scheduler Phase 1 + metric fan-out Phase 2 + bot and web-viz enhancements built in one pass
Decision: implement the scheduler schema (migration 0018), the deterministic
detection engine with 12 unit tests, the approval/execution engine, the metric
extraction fan-out, four scheduler API routes, a Scheduler panel in Discovery,
the animated SchedulerBot, and the 3D web enhancements (fullscreen, community
clouds, bridge arrows, proximity edge brightening, star counter-rotation) as
one bundled prompt.
Reasoning and notable deviations, each reconciling the prompt with the
codebase or with itself:
- scheduler_runs carries a status column (awaiting_approval | executing |
  completed | failed) that the prompt's column list omitted but its approval
  workflow requires. scheduler_tasks adds deferred and rejected statuses so
  the Defer/Reject controls have real states.
- The prompt's missing-metrics rule required a completed synthesis, but its
  expected output requires cosmic-structure (never synthesized) to be flagged.
  Metric extraction reads papers directly, so the synthesis precondition was
  dropped. Likewise never-synthesized libraries queue re_synthesize, or they
  would be invisible to the scheduler forever.
- The prompt's "all tasks in a run succeed or all fail" transactionality is
  impossible without undoing agents' own committed transactional writes.
  Implemented instead: per-task transactional state, run counters always
  consistent, failures recorded per task, later tasks still run.
- The bot lives at apps/web/components/scheduler/scheduler-bot.tsx (the
  prompt said packages/web and PascalCase filename; this repo's app is
  apps/web with kebab-case files per CLAUDE.md).
- The octahedron community clouds REPLACE the earlier radial sprite halos
  rather than stacking on them (one glow system, not two); clouds are
  non-pickable, fade over ~1s on toggle/legend/camera-inside, and are ON by
  default with a toggle. Edge arrows (lower-degree toward higher-degree on
  bridges) are OFF by default. The existing star field gained a slow
  counter-rotation instead of a second constellation layer.
- METRIC_EXTRACTION_BATCH_SIZE is stored and documented but not yet enforced:
  the existing scribe CLI has no LIMIT mode and modifying scribe was out of
  scope. ONLY_MISSING gives the actual cost control today.
Consequences: detection on the real corpus (run f495f955) surfaced exactly
the expected picture: extract_metrics on cosmic-structure, generative-3d, and
urban-heat (auto-approved), re_synthesize cosmic-structure, and a corpus-level
cross-domain refresh, ~$5.90 total upper bound. A plumbing smoke test
(fan-out over spatial, ONLY_MISSING) recovered 81 metric rows from 2
previously skipped papers in 127s, proving the execution path end to end.
The spec's ~$0.30/library metrics estimate is optimistic against observed
Opus extraction costs; recorded as-is per the prompt, with the command result
recording what actually happened.
Decision: record that the standing plan (guarded reset plus a diverse corpus
reseed, intended to "give distance-forcing genuinely distant fields to bridge")
is aimed at the wrong constraint, and should be reconsidered before it is run.
Reasoning: with a valid API key the proposal pipeline completed cleanly for the
first time, every stage ok, and still produced zero proposals. The diagnostics
give the reason without ambiguity: 10 of 14 ABC candidates were dropped as
"fewer than 2 groundable evidence papers (no synthesized library covers them)",
and the proposer then declined to propose on the 4 survivors. Measuring library
coverage per community on run 8412b5ce shows why. Cosmological Large-Scale
Structure has 0 of 18 papers in a synthesized library and Foundation Models and
Representation Learning has 1 of 29, while the three near-neighbor 3D-vision and
urban communities are well covered (24/27, 14/17, 13/16). The corpus is already
diverse: cosmology, quantum field theory, and foundation models are all present
and are exactly what the top ABC candidates bridge (mesh to QFT, decay rate to
mesh, foundation model to implicit bias). Those candidates are ungroundable only
because the grounding contract requires evidence from a synthesized library, and
44 percent of the corpus sits in two communities that have none. A reseed adds
diversity the corpus does not lack, and would discard papers that are already the
right ones. Consequences: the cheaper and better-targeted unblock is to run
synthesis on the existing cosmic-structure library (it exists with 0 completed
synthesis runs) and to create plus synthesize a library covering the foundation
models cluster. Neither was run here: it is a real cost and it is wasted if the
reset happens anyway, so the choice is left to the human. The grounding contract
itself was NOT relaxed; requiring synthesized-library evidence is the provenance
guarantee and weakening it to manufacture proposals would be exactly the
fabrication this lab refuses.

### 2026-08-18 Community labeling in build-web fails silently; same opacity class as the fixed proposal bug
Decision: flag the bare catch at the community-labeling step in build-web as a
residual instance of the opacity bug the proposal pipeline was just hardened
against. Not fixed in this pass (diagnosis was the requested deliverable), but it
should get the same stage-note treatment. Reasoning: a web build ran against a
stale invalid key and completed with status "completed", notes null, and all five
community labels null. The deterministic majority of the build succeeded, so the
run looked healthy while the single LLM call inside it had failed and been
swallowed by a catch that records nothing. Diagnosing this required querying
web_communities directly, which is precisely the black-box situation the
diagnostics work was meant to eliminate. Degrading rather than aborting is
correct for a cosmetic step; recording nothing is not. Consequences: a rebuild
with a valid key restored all five labels (run 8412b5ce), confirming the cause.
Until build-web records why labeling degraded, an unlabeled 3D view is
indistinguishable from a successful build, and the operator cannot tell whether
labels are missing because of an API failure or because the run predates
labeling.

### 2026-08-18 Second proposal-failure episode was an invalid API key, distinct from the July credit exhaustion
Decision: none required; the hardened pipeline behaved as designed and no code
changed. Recorded because the failure mode is easily confused with the July one.
Reasoning: "Propose crossovers" failed again with the verbatim error 401
{"type":"error","error":{"type":"authentication_error","message":"API key is
invalid."}} at stage proposer_llm. This is not the July 400 credit-balance error.
A depleted balance returns 400 invalid_request_error naming the credit balance; a
401 authentication_error means the key string is not recognized, which happens on
rotation, revocation, or deletion. The distinction mattered in practice: credits
had been restored and the run still failed, and the key in .env.local was
confirmed rejected by a direct curl to api.anthropic.com that bypassed all
application code. Consequences: the staged diagnostics did their job, naming the
failing stage and carrying the upstream message verbatim instead of the old
opaque "The proposal run could not complete", and external-service degradation
(ConceptNet 502, Semantic Scholar 429) was recorded without blocking the run.
Operational note: a running Next.js dev server holds the env from boot, so
editing .env.local requires a restart before the new key takes effect.

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
