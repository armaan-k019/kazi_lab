"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { WebGraph3D } from "@/components/web/web-graph-3d";
import { AMBIENT, GLASS } from "@/lib/design-tokens";
import { useLab } from "./lab-context";

// ---------------------------------------------------------------------------
// THE ENVIRONMENT FIELD: the corpus graph as the interface's environment.
// ONE full-viewport canvas and ONE scene graph serve both tabs: ambient
// (dimmed, softly blurred, non-interactive, throttled) behind everything,
// and focus (the current portal interaction, full clarity) on Discovery.
// The transition is the ambient veil easing over 500ms, never a remount.
// ---------------------------------------------------------------------------

export function EnvironmentField({ focused }: { focused: boolean }) {
  const lab = useLab();
  const { data, groups, activity, selectedLibraryId, portalRect } = lab;
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  // CONTAINMENT: in focus the canvas clips to the portal region's box, so
  // in-scene label sprites are cut at the portal boundary instead of drawing
  // over the header, the tab bar, or the dock. Ambient and fullscreen stay
  // unclipped (ambient shows no text at all; fullscreen owns the viewport).
  const clipPath = useMemo(() => {
    if (!focused || isFullscreen || !portalRect) return "none";
    const right = Math.max(0, window.innerWidth - (portalRect.left + portalRect.width));
    const bottom = Math.max(0, window.innerHeight - (portalRect.top + portalRect.height));
    return `inset(${Math.max(0, portalRect.top)}px ${right}px ${bottom}px ${Math.max(0, portalRect.left)}px round 16px)`;
  }, [focused, isFullscreen, portalRect]);
  const emphasisRef = useRef<string | null>(null);
  useEffect(() => {
    emphasisRef.current = selectedLibraryId;
    lab.emphasizeLibrary(selectedLibraryId);
  }, [selectedLibraryId, lab]);

  if (!data?.run) return null; // nothing to render yet; the ground holds

  return (
    <>
      <div
        className="fixed inset-0 z-0"
        style={{ pointerEvents: focused ? "auto" : "none", clipPath, transition: "clip-path var(--focus-ms) var(--motion-ease)" }}
      >
        <WebGraph3D
          nodes={data.nodes}
          edges={data.edges}
          communities={data.communities}
          abc={data.abc}
          activity={activity}
          mode={focused ? "focus" : "ambient"}
          ambientActivityScale={lab.ambientActivityScale}
          fillParent
          onSelect={lab.openPaper}
          onSelectionChange={(refId) => {
            lab.setSelection(refId ? { kind: "paper", refId } : null);
            if (refId) {
              const node = data.nodes.find((n) => n.refId === refId);
              const libId = node?.libraryIds?.[0];
              if (libId) lab.setSelectedLibraryId(libId);
              lab.openPanel("discoveries");
            }
          }}
          registerApi={(api) => {
            lab.registerPortalApi(api);
            if (api && emphasisRef.current) lab.emphasizeLibrary(emphasisRef.current);
          }}
          onThoughtCaptionClick={(index) => {
            lab.openPanel("discoveries");
            const g = groups.find((x) => x.pairings.some((p) => p.sourceIndex === index));
            if (g) lab.setSelection({ kind: "finding", signature: g.signature });
          }}
        />
      </div>
      {/* The veil: ambient dim + blur, cleared in focus. Purely visual. */}
      <div aria-hidden="true" className={`ambient-veil pointer-events-none fixed inset-0 z-[1] ${focused ? "focused" : ""}`} />
    </>
  );
}

// ---------------------------------------------------------------------------
// DEV TUNING PANEL (development builds only): the lesson from the stipple
// failure is that blind generative aesthetics need live dials. Sliders write
// CSS variables (and the ambient activity scale) live, persist to
// localStorage, and print a copyable token diff for baking keepers into
// design-tokens.ts.
// ---------------------------------------------------------------------------

const DEV_STORAGE_KEY = "kazi.dev.tuning";

type DevValues = {
  ambientDim: number;
  ambientBlurPx: number;
  panelFillAlpha: number;
  panelBlurPx: number;
  greenGlowAlpha: number;
  groundRadial: number;
  ambientActivityScale: number;
};

const DEV_DEFAULTS: DevValues = {
  ambientDim: AMBIENT.dim,
  ambientBlurPx: parseFloat(AMBIENT.blur),
  panelFillAlpha: 0.045,
  panelBlurPx: parseFloat(GLASS.blur),
  greenGlowAlpha: 0.12,
  groundRadial: AMBIENT.groundRadial,
  ambientActivityScale: AMBIENT.activityScale,
};

function applyDevValues(v: DevValues, setAmbientActivityScale: (x: number) => void): void {
  const root = document.documentElement.style;
  root.setProperty("--ambient-dim", String(v.ambientDim));
  root.setProperty("--ambient-blur", `${v.ambientBlurPx}px`);
  root.setProperty("--glass-fill", `rgba(239, 244, 239, ${v.panelFillAlpha})`);
  root.setProperty("--glass-blur", `${v.panelBlurPx}px`);
  root.setProperty("--green-tint", `rgba(55, 193, 134, ${v.greenGlowAlpha})`);
  root.setProperty("--ground-radial", String(v.groundRadial));
  setAmbientActivityScale(v.ambientActivityScale);
}

export function DevTuningPanel() {
  const { setAmbientActivityScale } = useLab();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<DevValues>(DEV_DEFAULTS);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DEV_STORAGE_KEY);
      if (stored) {
        const v = { ...DEV_DEFAULTS, ...(JSON.parse(stored) as Partial<DevValues>) };
        setValues(v);
        applyDevValues(v, setAmbientActivityScale);
      }
    } catch {
      // Corrupt storage: defaults stand.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (process.env.NODE_ENV === "production") return null;

  const set = <K extends keyof DevValues>(key: K, value: number) => {
    const next = { ...values, [key]: value };
    setValues(next);
    applyDevValues(next, setAmbientActivityScale);
    try {
      window.localStorage.setItem(DEV_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private mode: no persistence.
    }
  };

  const diff = Object.entries(values)
    .filter(([k, v]) => Math.abs(v - DEV_DEFAULTS[k as keyof DevValues]) > 1e-9)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  return (
    <div className="pointer-events-auto fixed bottom-3 left-3 z-50">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="glass rounded-full px-2.5 py-1 text-caption text-ink-500 transition-colors hover:text-ink"
        >
          dev tuning
        </button>
      ) : (
        <div className="glass-raised w-[280px] p-3">
          <div className="flex items-center">
            <p className="caps-label">dev tuning</p>
            <button type="button" onClick={() => setOpen(false)} className="ml-auto text-caption text-ink-500 hover:text-ink">
              close
            </button>
          </div>
          <div className="mt-2 space-y-1.5">
            <DevSlider label="ambient dim" min={0} max={0.9} step={0.01} value={values.ambientDim} onChange={(v) => set("ambientDim", v)} />
            <DevSlider label="ambient blur px" min={0} max={20} step={0.5} value={values.ambientBlurPx} onChange={(v) => set("ambientBlurPx", v)} />
            <DevSlider label="panel fill alpha" min={0.01} max={0.16} step={0.005} value={values.panelFillAlpha} onChange={(v) => set("panelFillAlpha", v)} />
            <DevSlider label="panel blur px" min={0} max={32} step={1} value={values.panelBlurPx} onChange={(v) => set("panelBlurPx", v)} />
            <DevSlider label="green glow alpha" min={0} max={0.4} step={0.01} value={values.greenGlowAlpha} onChange={(v) => set("greenGlowAlpha", v)} />
            <DevSlider label="ground radial" min={0} max={1} step={0.02} value={values.groundRadial} onChange={(v) => set("groundRadial", v)} />
            <DevSlider label="ambient activity" min={0} max={1} step={0.02} value={values.ambientActivityScale} onChange={(v) => set("ambientActivityScale", v)} />
          </div>
          {diff && (
            <div className="mt-2 border-t border-hairline pt-2">
              <p className="caps-label">token diff (bake keepers)</p>
              <pre className="mt-1 select-all font-mono text-micro leading-relaxed text-ink-600">{diff}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DevSlider({ label, min, max, step, value, onChange }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-2 text-caption text-ink-600">
      <span className="w-28 shrink-0">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-1 flex-1" />
      <span className="w-10 shrink-0 text-right font-mono text-micro text-ink-500">{value}</span>
    </label>
  );
}
