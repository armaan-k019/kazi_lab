"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatRelativeTime } from "@/lib/format";
import { useLab } from "./lab-context";
import { BotHome } from "./bot-home";
import { PANEL_REGISTRY, type PanelBadgeContext, type ShellTab } from "./panel-registry";

// ---------------------------------------------------------------------------
// THE SHARED SHELL, editorial skin: a line of type for the status bar (no
// container), the primary region bleeding into its space, and the dock
// delineated by a single hairline rule instead of a card. One implementation,
// two configurations; behavior identical to the pre-art-direction shell.
// ---------------------------------------------------------------------------

const SHELL_HEIGHT = "calc(100vh - 132px)";
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
  const primaryRef = useRef<HTMLDivElement | null>(null);

  // Report the primary region's rect so the focused field clips to it (the
  // portal is a clean window; its sprites stay inside it). Research reports
  // too, harmlessly: the clip only applies in focus mode.
  useEffect(() => {
    const el = primaryRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        lab.setPortalRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", measure);
      lab.setPortalRect(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      <div className="relative mt-4 flex min-h-0 flex-1 flex-col gap-6 lg:flex-row" style={isFullscreen ? { backgroundColor: "var(--portal-bg)" } : undefined}>
        {/* PRIMARY REGION: a transparent window onto the environment field.
            pointer-events fall through to the field; interactive children
            (the pipeline strip, the bot) re-enable their own. */}
        <div ref={primaryRef} className="pointer-events-none relative min-h-[320px] flex-1">
          {primary}
          <BotHome />
        </div>

        {/* DOCK: a hairline rule instead of a card. One panel at a time. */}
        <aside
          className={
            isFullscreen
              ? "glass-raised pointer-events-auto absolute right-3 top-12 z-40 flex max-h-[calc(100vh-6rem)] w-[400px] flex-col overflow-hidden"
              : "glass pointer-events-auto flex min-h-0 flex-col overflow-hidden lg:w-[440px]"
          }
        >
          <nav className="flex shrink-0 items-end gap-5 overflow-x-auto border-b border-hairline px-4 pb-2 pt-3">
            {panels.map((p) => {
              const disabled = p.enabled?.() === false;
              const badge = p.badge?.(badgeCtx) ?? null;
              const isActive = p.id === active.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => openPanel(p.id)}
                  className={`caps-label-lg relative flex shrink-0 items-center gap-1.5 whitespace-nowrap pb-1 transition-colors duration-(--motion-disclose) ${
                    isActive ? "!text-ink" : "hover:!text-ink-700"
                  } ${disabled ? "opacity-40" : ""}`}
                  title={disabled ? `${p.label} (coming in Phase 3)` : p.label}
                >
                  {p.label}
                  {badge !== null && <span className="font-mono text-micro text-green-deep">{badge}</span>}
                  {/* Active state: a green rule, not a filled pill. */}
                  {isActive && <span className="absolute inset-x-0 -bottom-[9px] h-[2px] bg-green" aria-hidden="true" />}
                </button>
              );
            })}
            <span className="ml-auto shrink-0 cursor-help pb-1 text-caption text-ink-400" title={"keyboard: [ and ] cycle panels · digits jump · Esc clears the selection (and exits fullscreen)"}>
              ?
            </span>
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <ActiveComponent />
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// STATUS BAR: a line of editorial type on paper, hairline rule below. Counts
// are machine numbers, so they sit in mono. Every segment jumps somewhere.
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
    <div className="glass pointer-events-auto flex flex-wrap items-baseline gap-x-6 gap-y-1 px-4 py-2">
      <Segment onClick={() => openPanel("diagnostics")} title="open diagnostics">
        <Num>{data?.nodes.length ?? "…"}</Num> papers <span className="text-ink-400">/</span> <Num>{data?.communities.length ?? "…"}</Num> communities
      </Segment>
      <Segment onClick={() => openPanel("diagnostics")} title="open diagnostics">
        web {data?.run?.completedAt ? `built ${formatRelativeTime(data.run.completedAt)}` : "not built"}
      </Segment>
      <Segment onClick={() => openPanel("discoveries")} title="open discoveries">
        <Num>{groups.length}</Num> findings
      </Segment>
      <Segment onClick={() => openPanel("scheduler")} title="open scheduler">
        scheduler <span className={executing > 0 ? "text-green-deep" : "text-ink"}>{schedulerLabel}</span>
      </Segment>
      {lastDoneRecent && (
        <Segment onClick={() => openPanel("scheduler")} title="open scheduler">
          done: {KIND_LABEL[lastDoneRecent.kind] ?? lastDoneRecent.kind} {lastDoneRecent.scopeNames.join(", ")} {formatRelativeTime(lastDoneRecent.completedAt!)}
        </Segment>
      )}
      <span className="ml-auto flex items-center gap-1.5" title={`activity ${(activity * 100).toFixed(0)}%`}>
        {/* Green as signal: the one live dot. Breathes with activity, never blinks. */}
        <span
          className="inline-block h-2 w-2 rounded-full bg-green transition-opacity duration-(--motion-panel)"
          style={{ opacity: 0.3 + 0.7 * activity }}
        />
        <span className="caps-label">activity</span>
      </span>
    </div>
  );
}

function Num({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-body text-ink">{children}</span>;
}

function Segment({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="text-mid text-ink-600 transition-colors duration-(--motion-disclose) hover:text-ink"
    >
      {children}
    </button>
  );
}
