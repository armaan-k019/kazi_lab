"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { BOTANY_DEFAULTS, type BotanyConfig } from "@/lib/botany-config";
import { libraryToTreeParams, type LibraryBotanyInput, type StageLite } from "@/lib/botany";
import { BotanyScene, type SceneBridge, type SceneTree } from "@/components/botany/botany-scene";
import { BotanyLegend } from "@/components/botany/botany-legend";
import type { PipelineLibrary, ResearchPipeline } from "@/lib/types";

// ---------------------------------------------------------------------------
// /botany-test: the tuning cockpit for the botany generator. Renders REAL
// libraries as trees (single or two-trees-plus-bridge), exposes EVERY config
// tunable as a live control (generated from the config object so none can be
// forgotten), shows the derived params next to the tree so the human can
// verify the mapping is honest, and exports the tuned values as a config
// diff to bake back into BOTANY_DEFAULTS.
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

// Slider range heuristics so every numeric tunable gets a sensible control.
function rangeFor(key: string, def: number): { min: number; max: number; step: number } {
  if (def === 0) return { min: 0, max: 1, step: 0.01 };
  if (def <= 1.5) return { min: 0, max: Math.max(1, def * 2.5), step: 0.01 };
  if (def <= 20) return { min: 0, max: def * 3, step: def >= 4 ? 1 : 0.1 };
  return { min: 0, max: def * 3, step: 1 };
}

export default function BotanyTestPage() {
  const [pipeline, setPipeline] = useState<ResearchPipeline | null>(null);
  const [botany, setBotany] = useState<BotanyApi | null>(null);
  const [config, setConfig] = useState<BotanyConfig>({ ...BOTANY_DEFAULTS });
  const [selected, setSelected] = useState<string>("spatial");
  const [mode, setMode] = useState<"single" | "pair" | "forest">("forest");
  const [pairA, setPairA] = useState<string>("spatial");
  const [pairB, setPairB] = useState<string>("cosmic-structure");
  const [stats, setStats] = useState<{ drawCallsPerTree: number; branchInstances: number; leafInstances: number; effectiveVertices: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const deferredConfig = useDeferredValue(config);

  useEffect(() => {
    fetch("/api/research/pipeline").then((r) => r.json()).then((b: ResearchPipeline) => { if (!("error" in b)) setPipeline(b); }).catch(() => {});
    fetch("/api/botany").then((r) => r.json()).then((b: BotanyApi) => { if (!("error" in b)) setBotany(b); }).catch(() => {});
  }, []);

  const inputs = useMemo(() => {
    if (!pipeline || !botany) return [];
    const byId = new Map(botany.libraries.map((l) => [l.id, l]));
    return pipeline.libraries.filter((l) => !l.isAllPapers && byId.has(l.id)).map((l) => toInput(l, byId.get(l.id)!));
  }, [pipeline, botany]);

  const byName = useMemo(() => new Map(inputs.map((i) => [i.name, i])), [inputs]);

  const { trees, bridges, active } = useMemo((): { trees: SceneTree[]; bridges: SceneBridge[]; active: LibraryBotanyInput[] } => {
    if (inputs.length === 0) return { trees: [], bridges: [], active: [] };
    if (mode === "single") {
      const input = byName.get(selected) ?? inputs[0];
      return { trees: [{ params: libraryToTreeParams(input, deferredConfig), x: 0, z: 0 }], bridges: [], active: [input] };
    }
    if (mode === "forest") {
      // FOREST PREVIEW: all real trees with the lighting rig and every real
      // bridge, so the human tunes the composed scene, not one lone tree.
      const spacing = 2.8;
      const x0 = -((inputs.length - 1) * spacing) / 2;
      const sceneTrees: SceneTree[] = inputs.map((input, i) => ({ params: libraryToTreeParams(input, deferredConfig), x: x0 + i * spacing, z: 0 }));
      const indexById = new Map(inputs.map((x, i) => [x.id, i]));
      const sceneBridges: SceneBridge[] = (botany?.bridges ?? [])
        .filter((br) => indexById.has(br.a) && indexById.has(br.b))
        .map((br) => ({ fromIndex: indexById.get(br.a)!, toIndex: indexById.get(br.b)!, linkCount: br.linkCount }));
      return { trees: sceneTrees, bridges: sceneBridges, active: inputs };
    }
    const a = byName.get(pairA) ?? inputs[0];
    const b = byName.get(pairB) ?? inputs[1] ?? inputs[0];
    const gap = 2.6;
    const sceneTrees: SceneTree[] = [
      { params: libraryToTreeParams(a, deferredConfig), x: -gap / 2, z: 0 },
      { params: libraryToTreeParams(b, deferredConfig), x: gap / 2, z: 0 },
    ];
    const real = (botany?.bridges ?? []).find((br) => (br.a === a.id && br.b === b.id) || (br.a === b.id && br.b === a.id));
    return {
      trees: sceneTrees,
      bridges: real ? [{ fromIndex: 0, toIndex: 1, linkCount: real.linkCount }] : [],
      active: [a, b],
    };
  }, [inputs, byName, mode, selected, pairA, pairB, deferredConfig, botany]);

  const realBridge = useMemo(() => {
    if (mode !== "pair" || !botany) return null;
    const a = byName.get(pairA);
    const b = byName.get(pairB);
    if (!a || !b) return null;
    return botany.bridges.find((br) => (br.a === a.id && br.b === b.id) || (br.a === b.id && br.b === a.id)) ?? null;
  }, [mode, botany, byName, pairA, pairB]);

  const set = <K extends keyof BotanyConfig>(key: K, value: BotanyConfig[K]) => setConfig((c) => ({ ...c, [key]: value }));

  const diff = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(config) as (keyof BotanyConfig)[]) {
      if (JSON.stringify(config[key]) !== JSON.stringify(BOTANY_DEFAULTS[key])) out[key] = config[key];
    }
    return out;
  }, [config]);

  const copyDiff = async () => {
    const text = JSON.stringify(diff, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable: the diff is still visible below.
    }
  };

  const numericKeys = (Object.keys(BOTANY_DEFAULTS) as (keyof BotanyConfig)[]).filter((k) => typeof BOTANY_DEFAULTS[k] === "number");
  const colorKeys = (Object.keys(BOTANY_DEFAULTS) as (keyof BotanyConfig)[]).filter((k) => typeof BOTANY_DEFAULTS[k] === "string");

  return (
    <main className="mx-auto w-full max-w-[1500px] px-5 py-8">
      <h1 className="font-display text-headline text-ink">botany test</h1>
      <p className="mt-1 max-w-2xl text-small text-ink-500">
        A library rendered as a tree: every property derives from real data (papers, internal citations,
        pipeline state, community). Same library, same tree, every render. Tune by eye, then copy the
        config diff and bake it into BOTANY_DEFAULTS.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <ModeChip label="forest preview" active={mode === "forest"} onClick={() => setMode("forest")} />
        <ModeChip label="one tree" active={mode === "single"} onClick={() => setMode("single")} />
        <ModeChip label="two trees + bridge" active={mode === "pair"} onClick={() => setMode("pair")} />
        {mode === "single" ? (
          <Select value={selected} onChange={setSelected} options={inputs.map((i) => i.name)} />
        ) : (
          <>
            <Select value={pairA} onChange={setPairA} options={inputs.map((i) => i.name)} />
            <span className="text-caption text-ink-500">and</span>
            <Select value={pairB} onChange={setPairB} options={inputs.map((i) => i.name)} />
          </>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-5 lg:flex-row">
        <div className="min-w-0 flex-1">
          {trees.length > 0 ? (
            <BotanyScene trees={trees} bridges={bridges} config={deferredConfig} heightPx={620} onStats={setStats} />
          ) : (
            <div className="flex h-[620px] items-center justify-center rounded-(--radius-glass) bg-paper-alt">
              <p className="text-mid text-ink-500">Loading real library data…</p>
            </div>
          )}

          {mode === "pair" && (
            <p className="mt-2 text-small text-ink-500">
              {realBridge
                ? `bridge: ${realBridge.linkCount} cross-domain link${realBridge.linkCount === 1 ? "" : "s"} between these libraries · "${realBridge.summary.slice(0, 110)}"`
                : "no cross-domain link recorded between these two libraries; no bridge is drawn (the tree never invents one)"}
            </p>
          )}

          <div className="mt-4 max-w-xs">
            <BotanyLegend />
          </div>

          {/* THE HONESTY READOUT: the mapping, stated next to the tree. */}
          <div className="mt-4 flex flex-wrap gap-8">
            {active.map((input) => {
              const p = libraryToTreeParams(input, deferredConfig);
              return (
                <div key={input.id} className="min-w-[260px]">
                  <p className="font-display text-lead text-ink">{input.name}</p>
                  <ul className="mt-1.5 space-y-0.5">
                    {p.derived.map((d, i) => (
                      <li key={i} className="text-caption text-ink-500">
                        <span className="font-mono text-ink-600">{d.label}</span> <span className="text-green-deep">-&gt;</span> {d.value}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>

          {stats && (
            <p className="mt-3 font-mono text-caption text-ink-500">
              per tree: ~{stats.drawCallsPerTree} draw calls · {stats.branchInstances} branch segments · {stats.leafInstances} leaves · ~{(stats.effectiveVertices / 1000).toFixed(1)}k effective vertices
            </p>
          )}
        </div>

        {/* THE TUNING SURFACE: every config tunable, generated from the
            config object so nothing is forgotten. */}
        <aside className="glass w-full shrink-0 self-start p-4 lg:w-[360px]">
          <div className="flex items-center gap-2">
            <p className="caps-label">tuning</p>
            <button type="button" onClick={() => void copyDiff()} className="ml-auto rounded-(--radius-control) border border-hairline-strong px-2 py-0.5 text-caption text-ink-600 hover:border-green hover:text-green-deep">
              {copied ? "copied" : "copy config"}
            </button>
            <button type="button" onClick={() => setConfig({ ...BOTANY_DEFAULTS })} className="rounded-(--radius-control) border border-hairline px-2 py-0.5 text-caption text-ink-500 hover:text-ink">
              reset
            </button>
          </div>

          <div className="mt-3 max-h-[560px] space-y-1 overflow-y-auto pr-1">
            {numericKeys.map((key) => {
              const def = BOTANY_DEFAULTS[key] as number;
              const r = rangeFor(key, def);
              const value = config[key] as number;
              return (
                <label key={key} className="flex items-center gap-2 text-caption text-ink-600">
                  <span className="w-40 shrink-0 truncate" title={key}>{key}</span>
                  <input type="range" min={r.min} max={r.max} step={r.step} value={value} onChange={(e) => set(key, Number(e.target.value) as BotanyConfig[typeof key])} className="h-1 flex-1" />
                  <span className="w-12 shrink-0 text-right font-mono text-micro text-ink-500">{Number(value).toFixed(r.step >= 1 ? 0 : 2)}</span>
                </label>
              );
            })}
            <p className="caps-label pt-2">colors</p>
            {colorKeys.map((key) => (
              <label key={key} className="flex items-center gap-2 text-caption text-ink-600">
                <span className="w-40 shrink-0 truncate" title={key}>{key}</span>
                <input type="color" value={config[key] as string} onChange={(e) => set(key, e.target.value as BotanyConfig[typeof key])} className="h-6 w-10 cursor-pointer rounded border border-hairline bg-transparent" />
                <span className="font-mono text-micro text-ink-500">{config[key] as string}</span>
              </label>
            ))}
            <p className="pt-2 text-micro text-ink-400">fruitBuckets thresholds are data mapping, edited in botany-config.ts</p>
          </div>

          {Object.keys(diff).length > 0 && (
            <div className="mt-3 border-t border-hairline pt-2">
              <p className="caps-label">config diff</p>
              <pre className="mt-1 max-h-40 select-all overflow-y-auto font-mono text-micro leading-relaxed text-ink-600">{JSON.stringify(diff, null, 2)}</pre>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}

function ModeChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`rounded-full border px-3 py-1 text-ui transition-colors ${active ? "border-green/60 bg-green-tint text-green-deep" : "border-hairline text-ink-600 hover:border-green/40 hover:text-green-deep"}`}>
      {label}
    </button>
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-(--radius-control) border border-hairline bg-paper-alt px-2 py-1 text-ui text-ink outline-none focus:border-green">
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}
