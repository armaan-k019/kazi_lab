"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { LabProvider, useLab } from "@/components/shell/lab-context";
import { BotHome } from "@/components/shell/bot-home";
import type { BotApi } from "@/components/scheduler/scheduler-bot";
import type { LibraryBotanyInput, StageLite } from "@/lib/botany";
import type { PipelineLibrary } from "@/lib/types";
import { MOTION } from "@/lib/design-tokens";
import { SCENES, type SceneId } from "./story-config";
import { StoryScene, type StoryBridge } from "./story-scene";

// ---------------------------------------------------------------------------
// THE STORY: the lab's front door. One persistent canvas (StoryScene) behind
// six scroll chapters of real DOM text; a custom rAF scroll-progress hook
// drives the camera (no scroll library needed beyond framer-motion, already
// a dependency, for the HTML fades). Every number is live from the read
// APIs; the penguin narrates one true line per scene. Reduced motion gets
// the same content as a static stacked read.
// ---------------------------------------------------------------------------

type BotanyApi = {
  libraries: { id: string; name: string; internalCitationEdges: number; internalCitationDensity: number; communityIndex: number | null }[];
  bridges: { a: string; b: string; linkCount: number; summary: string; level: string }[];
};

function toInput(p: PipelineLibrary, b: BotanyApi["libraries"][number]): LibraryBotanyInput {
  return {
    id: p.id,
    name: p.name,
    paperCount: p.paperCount,
    internalCitationDensity: b.internalCitationDensity,
    internalCitationEdges: b.internalCitationEdges,
    communityIndex: b.communityIndex,
    stages: {
      synthesis: p.stages.synthesis.state as StageLite,
      critic: p.stages.critic.state as StageLite,
      metricsRows: p.stages.metrics.rows,
      crossDomain: p.stages.crossDomain.state as StageLite,
      experiment: p.stages.experiment.state as StageLite,
      document: p.stages.document.state as StageLite,
    },
  };
}

// How many pipeline stages a library has completed (for the narrator's
// healthiest-vs-barest line; a pure count of real states).
function doneCount(l: PipelineLibrary): number {
  return Object.values(l.stages).filter((s) => (s as { state: string }).state === "done").length;
}

export function StoryPage() {
  return (
    <LabProvider>
      <StoryInner />
    </LabProvider>
  );
}

function StoryInner() {
  const lab = useLab();
  const reducedMotion = useReducedMotion() ?? false;
  const [botany, setBotany] = useState<BotanyApi | null>(null);
  const progressRef = useRef(0);
  const [activeScene, setActiveScene] = useState<SceneId>("hero");
  const botApiRef = useRef<BotApi | null>(null);
  const narratedRef = useRef<SceneId | null>(null);

  useEffect(() => {
    fetch("/api/botany").then((r) => r.json()).then((b: BotanyApi) => { if (!("error" in b)) setBotany(b); }).catch(() => {});
  }, []);

  // The forest inputs: real pipeline state joined with real citation and
  // community data.
  const inputs = useMemo(() => {
    if (!lab.pipeline || !botany) return [];
    const byId = new Map(botany.libraries.map((l) => [l.id, l]));
    return lab.pipeline.libraries.filter((l) => !l.isAllPapers && byId.has(l.id)).map((l) => toInput(l, byId.get(l.id)!));
  }, [lab.pipeline, botany]);

  const bridges = useMemo((): StoryBridge[] => {
    if (!botany || inputs.length === 0) return [];
    const indexById = new Map(inputs.map((x, i) => [x.id, i]));
    return botany.bridges
      .filter((b) => indexById.has(b.a) && indexById.has(b.b))
      .map((b) => ({ aIndex: indexById.get(b.a)!, bIndex: indexById.get(b.b)!, linkCount: b.linkCount }));
  }, [botany, inputs]);

  // Scroll engine: rAF-throttled progress into a ref (the canvas consumes it
  // without re-rendering React) plus a scene index state that changes rarely.
  const totalVh = SCENES.reduce((s, x) => s + x.lengthVh, 0);
  useEffect(() => {
    let raf = 0;
    let ticking = false;
    const update = () => {
      ticking = false;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      progressRef.current = p;
      // Which scene: cumulative scroll lengths.
      let acc = 0;
      let id: SceneId = SCENES[SCENES.length - 1].id;
      for (const s of SCENES) {
        acc += s.lengthVh / totalVh;
        if (p < acc) {
          id = s.id;
          break;
        }
      }
      setActiveScene((prev) => (prev === id ? prev : id));
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        raf = requestAnimationFrame(update);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [totalVh]);

  // THE NARRATOR: one honest line per scene, generated from live state, plus
  // a scene-cued antic. Never fires twice for the same scene entry.
  const sceneLine = useCallback(
    (id: SceneId): { line: string; antic: string | null } => {
      const pipe = (lab.pipeline?.libraries ?? []).filter((l) => !l.isAllPapers);
      switch (id) {
        case "hero":
          return { line: "hi, I run this lab's schedule. scroll and I'll show you around", antic: "notice_wave" };
        case "corpus": {
          const n = lab.data?.nodes.length;
          const m = lab.data?.communities.length;
          return { line: n && m ? `${n} papers across ${m} communities, all real` : "the corpus is still loading", antic: null };
        }
        case "worlds": {
          if (pipe.length === 0) return { line: "no libraries yet; the forest is waiting", antic: "look_around" };
          const sorted = [...pipe].sort((a, b) => doneCount(b) - doneCount(a));
          const lush = sorted[0];
          const bare = pipe.find((l) => l.stages.synthesis.state === "missing");
          return {
            line: bare
              ? `${lush.name} is thriving; ${bare.name} is still bare, it has no synthesis yet`
              : `${lush.name} is the healthiest tree right now`,
            antic: "look_around",
          };
        }
        case "bridges": {
          const g = lab.groups[0];
          return g
            ? { line: `the strongest bridge scores ${g.bestScore.toFixed(2)}, via ${g.bridgeConcepts[0] ?? "a shared concept"}`, antic: "stretch_yawn" }
            : { line: "no cross-domain findings yet; the trees grow apart for now", antic: null };
        }
        case "next": {
          const t = (lab.scheduler?.tasks ?? []).find((x) => x.status === "queued" || x.status === "approved");
          return t
            ? { line: `next I want to ${t.kind.replace(/_/g, " ")}${t.scopeNames.length ? ` on ${t.scopeNames.join(", ")}` : ""}, about $${t.costEstimateUsd.toFixed(2)}`, antic: "peck_nod" }
            : { line: "nothing queued right now; the corpus is current", antic: "peck_nod" };
        }
        case "enter":
          return { line: "the working lab is through here", antic: "notice_wave" };
      }
    },
    [lab.data, lab.pipeline, lab.groups, lab.scheduler],
  );

  useEffect(() => {
    if (narratedRef.current === activeScene) return;
    narratedRef.current = activeScene;
    const { line, antic } = sceneLine(activeScene);
    lab.say(line);
    if (antic && !reducedMotion) botApiRef.current?.fireAntic(antic);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScene]);

  const fade = reducedMotion
    ? {}
    : {
        initial: { opacity: 0, y: 24 },
        whileInView: { opacity: 1, y: 0 },
        viewport: { amount: 0.4, once: false },
        transition: { duration: MOTION.panelMs / 1000, ease: [0.33, 1, 0.4, 1] as const },
      };

  const pipe = (lab.pipeline?.libraries ?? []).filter((l) => !l.isAllPapers);
  const queued = (lab.scheduler?.tasks ?? []).filter((t) => t.status === "queued" || t.status === "approved");

  const act = async (action: "approve" | "defer", taskId: string) => {
    try {
      await fetch("/api/scheduler/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, taskId }) });
    } catch {
      // The next poll shows the truth either way.
    }
  };

  return (
    <div className="relative">
      {inputs.length > 0 && <StoryScene inputs={inputs} bridges={bridges} progressRef={progressRef} reducedMotion={reducedMotion} />}

      {/* Persistent door to the working tool. */}
      <Link href="/lab" className="glass pointer-events-auto fixed right-4 top-4 z-30 px-3.5 py-1.5 text-ui text-ink-600 transition-colors duration-(--motion-disclose) hover:text-green-deep">
        enter the lab -&gt;
      </Link>

      {/* The narrator, fixed on the journey. */}
      <div className="pointer-events-none fixed bottom-0 right-0 z-30 h-44 w-72">
        <div className="relative h-full w-full">
          <BotHome registerBotApi={(api) => (botApiRef.current = api)} />
        </div>
      </div>

      {/* THE CHAPTERS: real DOM text (selectable, screen-reader legible). */}
      <main className="relative z-10">
        {/* SCENE 0: HERO */}
        <Chapter vh={SCENES[0].lengthVh}>
          <motion.div {...fade} className="max-w-3xl">
            <h1 className="font-display text-hero leading-none text-ink">kazi lab</h1>
            <p className="mt-4 max-w-xl text-lead leading-relaxed text-ink-600">
              A research lab that reads its own corpus, audits its own claims, and grows its fields like
              a forest. Everything you are about to see is its real state.
            </p>
            <p className="mt-10 caps-label animate-pulse">scroll</p>
          </motion.div>
        </Chapter>

        {/* SCENE 1: THE CORPUS */}
        <Chapter vh={SCENES[1].lengthVh}>
          <motion.div {...fade} className="glass max-w-xl p-6">
            <p className="caps-label">the corpus</p>
            <p className="mt-2 font-display text-display leading-tight text-ink">
              <span className="font-mono">{lab.data?.nodes.length ?? "…"}</span> papers,{" "}
              <span className="font-mono">{lab.data?.communities.length ?? "…"}</span> communities
            </p>
            <p className="mt-3 text-body leading-relaxed text-ink-600">
              Communities are not assigned; they emerge from the papers themselves:
            </p>
            <ul className="mt-2 space-y-0.5">
              {(lab.data?.communities ?? []).map((c) => (
                <li key={c.index} className="text-small text-ink-500">
                  {c.label ?? `community ${c.index}`} <span className="font-mono text-micro">({c.size})</span>
                </li>
              ))}
              {!lab.data && <li className="text-small text-ink-500">loading the corpus…</li>}
            </ul>
          </motion.div>
        </Chapter>

        {/* SCENE 2: THE WORLDS (the forest) */}
        <Chapter vh={SCENES[2].lengthVh} align="end">
          <motion.div {...fade} className="glass max-w-xl p-6">
            <p className="caps-label">the worlds</p>
            <p className="mt-2 font-display text-title leading-tight text-ink">Each library is a tree, grown from its real state.</p>
            <p className="mt-2 text-body leading-relaxed text-ink-600">
              Papers set its size, internal citations its branching, and the research pipeline its
              foliage: synthesized libraries are in leaf, audited ones are full, metrics hang as fruit.
              A bare tree is not a failure; it is work not yet done.
            </p>
            <ul className="mt-3 space-y-1.5">
              {pipe.map((l) => {
                const bare = l.stages.synthesis.state === "missing";
                return (
                  <li key={l.id} className="flex items-baseline gap-2 text-small">
                    <span className={`inline-block h-2 w-2 shrink-0 self-center rounded-full ${bare ? "bg-warm" : "bg-green"}`} />
                    <span className="text-ink">{l.name}</span>
                    <span className="text-ink-500">{bare ? "bare, no synthesis yet" : l.stages.critic.state === "done" ? "in full leaf" : "in leaf, unaudited"}</span>
                    <Link href={`/lab?view=research&library=${l.id}`} className="pointer-events-auto ml-auto text-caption text-green-deep underline-offset-2 hover:underline">
                      open in the lab
                    </Link>
                  </li>
                );
              })}
              {pipe.length === 0 && <li className="text-small text-ink-500">no libraries yet</li>}
            </ul>
          </motion.div>
        </Chapter>

        {/* SCENE 3: THE BRIDGES */}
        <Chapter vh={SCENES[3].lengthVh}>
          <motion.div {...fade} className="glass max-w-xl p-6">
            <p className="caps-label">the bridges</p>
            <p className="mt-2 font-display text-title leading-tight text-ink">Where distant fields turn out to rhyme.</p>
            <p className="mt-2 text-body leading-relaxed text-ink-600">
              The vines between trees are real cross-domain findings, discovered deterministically and
              audited before they are believed.
            </p>
            <ul className="mt-3 space-y-2.5">
              {lab.groups.slice(0, 3).map((g) => (
                <li key={g.signature} className="border-l-2 border-green pl-3">
                  <p className="font-display text-lead leading-tight text-ink">
                    {(lab.data?.communities.find((c) => c.index === g.communityPair[0])?.label ?? `community ${g.communityPair[0]}`)}{" "}
                    <span className="text-green-deep">&lt;-&gt;</span>{" "}
                    {(lab.data?.communities.find((c) => c.index === g.communityPair[1])?.label ?? `community ${g.communityPair[1]}`)}
                  </p>
                  <p className="mt-0.5 text-small text-ink-500">
                    via {g.bridgeConcepts.join(", ")} · score <span className="font-mono">{g.bestScore.toFixed(2)}</span>
                  </p>
                </li>
              ))}
              {lab.groups.length === 0 && <li className="text-small text-ink-500">no cross-domain findings yet; that is the honest state</li>}
            </ul>
            <button
              type="button"
              onClick={() => void lab.propose()}
              disabled={lab.proposing}
              className="pointer-events-auto mt-4 rounded-(--radius-control) border border-hairline-strong px-3 py-1.5 text-ui font-medium text-ink-600 transition-colors duration-(--motion-disclose) hover:border-green hover:text-green-deep disabled:opacity-50"
            >
              {lab.proposing ? "Proposing…" : "Propose crossovers"}
            </button>
            {lab.proposeOutcome && <p className="mt-2 text-small text-ink-500">{lab.proposeOutcome.message}</p>}
          </motion.div>
        </Chapter>

        {/* SCENE 4: WHAT THE LAB WANTS TO DO NEXT */}
        <Chapter vh={SCENES[4].lengthVh}>
          <motion.div {...fade} className="glass max-w-xl p-6">
            <p className="caps-label">what I want to do next</p>
            <p className="mt-2 font-display text-title leading-tight text-ink">The lab schedules its own work; a human approves it.</p>
            <ul className="mt-3 space-y-2">
              {queued.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 text-small">
                  <span className="text-ink">{t.kind.replace(/_/g, " ")}</span>
                  {t.scopeNames.length > 0 && <span className="text-ink-500">{t.scopeNames.join(", ")}</span>}
                  <span className="font-mono text-caption text-ink-500">~${t.costEstimateUsd.toFixed(2)}</span>
                  {t.status === "queued" ? (
                    <span className="pointer-events-auto ml-auto flex gap-1.5">
                      <button type="button" onClick={() => void act("approve", t.id)} className="rounded-(--radius-control) border border-green/50 px-2 py-0.5 text-caption text-green-deep hover:bg-green-tint">
                        approve
                      </button>
                      <button type="button" onClick={() => void act("defer", t.id)} className="rounded-(--radius-control) border border-hairline px-2 py-0.5 text-caption text-ink-500 hover:text-ink">
                        defer
                      </button>
                    </span>
                  ) : (
                    <span className="ml-auto text-caption text-green-deep">approved, ready to run</span>
                  )}
                </li>
              ))}
              {queued.length === 0 && <li className="text-small text-ink-500">nothing queued right now; the corpus is current</li>}
            </ul>
            <p className="mt-3 text-caption text-ink-400">cost figures are conservative upper bounds; execution happens in the lab</p>
          </motion.div>
        </Chapter>

        {/* SCENE 5: ENTER */}
        <Chapter vh={SCENES[5].lengthVh}>
          <motion.div {...fade} className="max-w-xl text-center">
            <p className="font-display text-display leading-tight text-ink">Come inside.</p>
            <p className="mx-auto mt-3 max-w-md text-body leading-relaxed text-ink-600">
              The working lab is where the reading, auditing, and growing happens: grounded in its
              sources, skeptical of itself, and honest about what it does not know yet.
            </p>
            <Link
              href="/lab"
              className="pointer-events-auto mt-6 inline-block rounded-(--radius-control) bg-green-deep px-6 py-3 font-display text-lead text-paper transition-opacity hover:opacity-90"
            >
              enter the lab
            </Link>
          </motion.div>
        </Chapter>
      </main>
    </div>
  );
}

// One chapter: a full-viewport (or longer) section whose content is real DOM
// text floating over the canvas. pointer-events pass through empty space to
// keep scrolling natural; interactive elements re-enable their own.
function Chapter({ vh, align = "start", children }: { vh: number; align?: "start" | "end"; children: React.ReactNode }) {
  return (
    <section
      className={`pointer-events-none relative flex items-center px-6 lg:px-16 ${align === "end" ? "justify-end" : "justify-start"}`}
      style={{ minHeight: `${vh}vh` }}
    >
      {children}
    </section>
  );
}
