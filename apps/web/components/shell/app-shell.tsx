"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatRelativeTime } from "@/lib/format";
import { useLab } from "./lab-context";
import { BotHome } from "./bot-home";
import { PANEL_REGISTRY, type PanelBadgeContext, type ShellTab } from "./panel-registry";

// ---------------------------------------------------------------------------
// THE SHARED SHELL: one implementation, two configurations. Both tabs render
// this with their own primary region; panels come from the shared registry
// filtered by tab. Status bar on top (global; lab state is lab state), the
// primary region dominant, the dock on the right (side, not bottom: primary
// regions want vertical space), dropping below at narrow widths. In
// fullscreen the dock overlays as a translucent card. The bot lives in the
// primary region's bottom-right corner on both tabs.
// ---------------------------------------------------------------------------

const SHELL_HEIGHT = "calc(100vh - 148px)";
const SHELL_MIN_HEIGHT = 560;
const RECENT_TASK_WINDOW_MS = 10 * 60_000;

const KIND_LABEL: Record<string, string> = {
  extract_metrics: "extract metrics",
  re_synthesize: "re-synthesize",
  re_critique: "re-critique",
  extract_cross_domain: "cross-domain",
  propose_crossovers: "propose crossovers",
};

export function AppShell({ tab, primary }: { tab: ShellTab; primary: React.ReactNode }) {
  const lab = useLab();
  const [isFullscreen, setIsFullscreen] = useState(false);

  const panels = useMemo(
    () => [...PANEL_REGISTRY].filter((p) => p.tab === tab || p.tab === "both").sort((a, b) => a.order - b.order),
    [tab],
  );
  const storageKey = `kazi.shell.panel.${tab}`;
  const [activePanel, setActivePanel] = useState<string>(() => {
    if (typeof window === "undefined") return panels[0]?.id ?? "";
    const stored = window.localStorage.getItem(storageKey);
    return stored && panels.some((p) => p.id === stored) ? stored : (panels[0]?.id ?? "");
  });
  const openPanel = useCallback(
    (id: string) => {
      if (!panels.some((p) => p.id === id)) return; // not in this tab: no-op
      setActivePanel(id);
      try {
        window.localStorage.setItem(storageKey, id);
      } catch {
        // Private mode: the choice simply does not persist.
      }
    },
    [panels, storageKey],
  );

  // The mounted shell is the lab's panel opener (status bar, portal captions).
  useEffect(() => {
    lab.registerPanelOpener(openPanel);
    return () => lab.registerPanelOpener(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPanel]);

  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Keyboard: Esc clears the shared selection; [ ] cycle panels; digits jump.
  const enabledPanels = useMemo(() => panels.filter((p) => p.enabled?.() !== false), [panels]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (e.key === "Escape") {
        lab.setSelection(null);
        return;
      }
      if (e.key === "[" || e.key === "]") {
        const idx = enabledPanels.findIndex((p) => p.id === activePanel);
        const next = e.key === "]" ? (idx + 1) % enabledPanels.length : (idx - 1 + enabledPanels.length) % enabledPanels.length;
        openPanel(enabledPanels[next].id);
        return;
      }
      const digit = Number(e.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= enabledPanels.length) openPanel(enabledPanels[digit - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanel, enabledPanels, openPanel]);

  const badgeCtx: PanelBadgeContext = {
    findingCount: lab.groups.length,
    queuedTasks: (lab.scheduler?.tasks ?? []).filter((t) => t.status === "queued" || t.status === "approved").length,
    unauditedSyntheses: lab.pipeline?.unauditedSyntheses ?? 0,
  };
  const active = panels.find((p) => p.id === activePanel) ?? panels[0];
  const ActiveComponent = active.component;

  return (
    <div className="flex flex-col" style={{ height: SHELL_HEIGHT, minHeight: SHELL_MIN_HEIGHT }}>
      <StatusBar />
      <div className="relative mt-3 flex min-h-0 flex-1 flex-col gap-3 lg:flex-row" style={isFullscreen ? { backgroundColor: "#0b0d10" } : undefined}>
        {/* PRIMARY REGION (portal on Discovery, pipeline on Research). The
            bot's home is its bottom-right corner on both tabs. */}
        <div className="relative min-h-[320px] flex-1 overflow-hidden rounded-xl border border-border bg-surface">
          {primary}
          <BotHome />
        </div>

        {/* DOCK: one panel at a time, rail from the shared registry. */}
        <aside
          className={
            isFullscreen
              ? "absolute right-3 top-12 z-40 flex max-h-[calc(100vh-6rem)] w-[400px] flex-col overflow-hidden rounded-xl border border-border bg-surface/85 backdrop-blur-md"
              : "flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface lg:w-[440px]"
          }
        >
          <nav className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
            {panels.map((p) => {
              const disabled = p.enabled?.() === false;
              const badge = p.badge?.(badgeCtx) ?? null;
              const isActive = p.id === active.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => openPanel(p.id)}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
                    isActive ? "border-accent/50 bg-accent-dim text-accent" : "border-transparent text-text-secondary hover:border-border hover:text-text-primary"
                  } ${disabled ? "opacity-45" : ""}`}
                  title={disabled ? `${p.label} (coming in Phase 3)` : p.label}
                >
                  <span className="font-mono text-[10px] text-text-muted">{p.icon}</span>
                  {p.label}
                  {badge !== null && <span className="rounded-full bg-accent-dim px-1.5 text-[10px] font-medium text-accent">{badge}</span>}
                </button>
              );
            })}
            <span className="ml-auto cursor-help pr-1 text-[11px] text-text-muted" title={"keyboard: [ and ] cycle panels · digits jump · Esc clears the selection (and exits fullscreen)"}>
              ?
            </span>
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <ActiveComponent />
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// STATUS BAR: global, identical on both tabs; every segment jumps somewhere.
// ---------------------------------------------------------------------------
function StatusBar() {
  const { data, scheduler, activity, groups, openPanel } = useLab();
  const tasks = scheduler?.tasks ?? [];
  const executing = tasks.filter((t) => t.status === "executing").length;
  const pending = tasks.filter((t) => t.status === "queued" || t.status === "approved").length;
  const schedulerLabel = executing > 0 ? `executing ${executing}` : pending > 0 ? `${pending} queued` : "idle";
  const lastDone = tasks
    .filter((t) => t.status === "completed" && t.completedAt)
    .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime())[0];
  const lastDoneRecent = lastDone && Date.now() - new Date(lastDone.completedAt!).getTime() < RECENT_TASK_WINDOW_MS ? lastDone : null;

  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 rounded-xl border border-border bg-surface px-2 py-1.5">
      <Segment onClick={() => openPanel("diagnostics")} title="open diagnostics">
        <span className="text-text-primary">{data?.nodes.length ?? "…"}</span> papers · <span className="text-text-primary">{data?.communities.length ?? "…"}</span> communities
      </Segment>
      <Dot />
      <Segment onClick={() => openPanel("diagnostics")} title="open diagnostics">
        web {data?.run?.completedAt ? `built ${formatRelativeTime(data.run.completedAt)}` : "not built"}
      </Segment>
      <Dot />
      <Segment onClick={() => openPanel("discoveries")} title="open discoveries">
        <span className="text-text-primary">{groups.length}</span> findings
      </Segment>
      <Dot />
      <Segment onClick={() => openPanel("scheduler")} title="open scheduler">
        scheduler <span className={executing > 0 ? "text-accent" : "text-text-primary"}>{schedulerLabel}</span>
      </Segment>
      {lastDoneRecent && (
        <>
          <Dot />
          <Segment onClick={() => openPanel("scheduler")} title="open scheduler">
            done: {KIND_LABEL[lastDoneRecent.kind] ?? lastDoneRecent.kind} {lastDoneRecent.scopeNames.join(", ")} {formatRelativeTime(lastDoneRecent.completedAt!)}
          </Segment>
        </>
      )}
      <span className="ml-auto flex items-center gap-1.5 pr-1" title={`activity ${(activity * 100).toFixed(0)}%`}>
        <span className="inline-block h-2 w-2 rounded-full bg-accent" style={{ opacity: 0.25 + 0.75 * activity }} />
        <span className="text-[11px] text-text-muted">activity</span>
      </span>
    </div>
  );
}

function Segment({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button type="button" onClick={onClick} title={title} className="rounded px-1.5 py-0.5 text-[12px] text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary">
      {children}
    </button>
  );
}

function Dot() {
  return <span className="text-[11px] text-text-muted">·</span>;
}
