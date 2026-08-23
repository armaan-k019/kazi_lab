"use client";

import { useRef, useState } from "react";
import { BOT_DEFAULTS, PROFILES, SchedulerBot, type BotApi, type BotProfileName, type BotTuning } from "@/components/scheduler/scheduler-bot";
import type { SchedulerBotState } from "@/lib/types";

const STATES: SchedulerBotState[] = ["idle", "thinking", "loading", "success", "error"];
const PROFILE_NAMES = Object.keys(PROFILES) as BotProfileName[];

// The bot's tuning cockpit. Claude Code cannot see renders; every aesthetic
// call here is the human's, made live with these controls. Once a combination
// looks right, bake the values into BOT_DEFAULTS in scheduler-bot.tsx.
export default function BotTestPage() {
  const [state, setState] = useState<SchedulerBotState>("idle");
  const [tuning, setTuning] = useState<BotTuning>({ ...BOT_DEFAULTS });
  const [antics, setAntics] = useState<string[]>([]);
  const botApiRef = useRef<BotApi | null>(null);
  const set = <K extends keyof BotTuning>(key: K, value: BotTuning[K]) => setTuning((t) => ({ ...t, [key]: value }));

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col items-center gap-8 px-6 py-12">
      <SchedulerBot
        state={state}
        size={280}
        tuning={tuning}
        registerApi={(api) => {
          botApiRef.current = api;
          setAntics(api?.antics ?? []);
        }}
      />

      <div className="flex flex-wrap items-center justify-center gap-2">
        {STATES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setState(s)}
            className={`rounded-full border px-3 py-1 text-ui transition-colors ${
              state === s ? "border-accent/50 bg-accent-dim text-accent" : "border-border text-text-secondary hover:border-accent/30 hover:text-accent"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="w-full space-y-4 rounded-xl border border-border bg-surface p-4">
        <p className="text-caption font-medium uppercase tracking-wide text-text-muted">tuning (live; bake keepers into BOT_DEFAULTS)</p>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <Toggle
            label="profile"
            options={PROFILE_NAMES}
            value={tuning.profile}
            onChange={(v) => set("profile", v as BotProfileName)}
          />
          <Toggle
            label="face"
            options={["beak", "mouth"]}
            value={tuning.faceStyle}
            onChange={(v) => set("faceStyle", v as BotTuning["faceStyle"])}
          />
          <Toggle
            label="material"
            options={["soft", "toon"]}
            value={tuning.materialStyle}
            onChange={(v) => set("materialStyle", v as BotTuning["materialStyle"])}
          />
          <label className="flex items-center gap-1.5 text-small text-text-secondary">
            <input type="checkbox" checked={tuning.cheeks} onChange={(e) => set("cheeks", e.target.checked)} /> cheeks
          </label>
          <label className="flex items-center gap-1.5 text-small text-text-secondary">
            <input type="checkbox" checked={tuning.waddle} onChange={(e) => set("waddle", e.target.checked)} /> waddle
          </label>
          <label className="flex items-center gap-1.5 text-small text-text-secondary">
            body green
            <input type="color" value={tuning.bodyGreen} onChange={(e) => set("bodyGreen", e.target.value)} className="h-6 w-10 cursor-pointer rounded border border-border bg-transparent" />
            <span className="font-mono text-micro text-text-muted">{tuning.bodyGreen}</span>
          </label>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
          <Slider label="belly coverage" min={0.4} max={0.8} step={0.01} value={tuning.bellyCoverage} onChange={(v) => set("bellyCoverage", v)} />
          <Slider label="eye size" min={0.7} max={1.4} step={0.01} value={tuning.eyeSize} onChange={(v) => set("eyeSize", v)} />
          <Slider label="eye height" min={-0.15} max={0.25} step={0.01} value={tuning.eyeHeight} onChange={(v) => set("eyeHeight", v)} />
          <Slider label="bounce amplitude" min={0.5} max={1.5} step={0.01} value={tuning.bounceAmplitude} onChange={(v) => set("bounceAmplitude", v)} />
          <Slider label="breathing speed" min={0.5} max={2} step={0.01} value={tuning.breathingSpeed} onChange={(v) => set("breathingSpeed", v)} />
          <Slider label="waddle roll (deg)" min={2} max={16} step={0.5} value={tuning.waddleRollDeg} onChange={(v) => set("waddleRollDeg", v)} />
          <Slider label="waddle speed" min={0.5} max={2} step={0.01} value={tuning.waddleSpeed} onChange={(v) => set("waddleSpeed", v)} />
          <Slider label="antic frequency" min={0} max={3} step={0.05} value={tuning.anticFrequency} onChange={(v) => set("anticFrequency", v)} />
          <Slider label="wander radius" min={0.1} max={1} step={0.01} value={tuning.wanderRadius} onChange={(v) => set("wanderRadius", v)} />
        </div>

        {antics.length > 0 && (
          <div>
            <p className="text-caption font-medium uppercase tracking-wide text-text-muted">fire an antic (plays immediately)</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {antics.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => botApiRef.current?.fireAntic(name)}
                  className="rounded-full border border-border px-2.5 py-0.5 text-caption text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
                >
                  {name.replace(/_/g, " ")}
                </button>
              ))}
            </div>
          </div>
        )}

        <button type="button" onClick={() => setTuning({ ...BOT_DEFAULTS })} className="rounded border border-border px-2 py-0.5 text-caption text-text-secondary transition-colors hover:border-accent/40 hover:text-accent">
          reset to defaults
        </button>
      </div>

      <p className="max-w-md text-center text-small leading-relaxed text-text-muted">
        what to judge: the silhouette (plush egg, not a ball), the face charm (big low-set eyes, highlight
        dots), each state's feel (idle breathes and blinks, thinking tilts with dots, loading bounces with
        squash, success jumps with sparkles, error deflates under a little cloud), and which material and
        face style read best.
      </p>
    </main>
  );
}

function Toggle({ label, options, value, onChange }: { label: string; options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <span className="flex items-center gap-1.5 text-small text-text-secondary">
      {label}
      <span className="flex overflow-hidden rounded-full border border-border">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onChange(o)}
            className={`px-2 py-0.5 text-caption transition-colors ${value === o ? "bg-accent-dim text-accent" : "text-text-secondary hover:text-accent"}`}
          >
            {o}
          </button>
        ))}
      </span>
    </span>
  );
}

function Slider({ label, min, max, step, value, onChange }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-2 text-small text-text-secondary">
      <span className="w-32 shrink-0">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-1 flex-1" />
      <span className="w-10 shrink-0 text-right font-mono text-micro text-text-muted">{value.toFixed(2)}</span>
    </label>
  );
}
