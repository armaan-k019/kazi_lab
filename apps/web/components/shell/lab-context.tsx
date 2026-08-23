"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { groupAbcCandidates, type GroupedFinding } from "@kazi-lab/web-graph/abc-grouping";
import { AMBIENT } from "@/lib/design-tokens";
import type { PipelineLibrary, ResearchPipeline, SchedulerBotState, SchedulerLatest, WebLatest, WebProposeDiagnostics, WebProposeOutcome } from "@/lib/types";
import { newFindingsLine, taskDoneLine, taskFailedLine, taskStartLine } from "@/lib/bot-speech";
import type { PortalApi } from "@/components/web/web-graph-3d";

// ---------------------------------------------------------------------------
// LAB CONTEXT: one provider above BOTH tabs. Lab state is lab state: the
// status bar, panels, portal, pipeline strip, and the bot's voice all read
// from here, so the two shells can never disagree and selection survives tab
// switches (cross-tab continuity).
// ---------------------------------------------------------------------------

const SCHEDULER_POLL_MS = 20_000;
const PIPELINE_POLL_MS = 60_000;
const ACTIVITY_EXECUTING = 0.85;
const ACTIVITY_QUEUED = 0.45;
const ACTIVITY_IDLE = 0.15;
const ACTIVITY_SURGE_WINDOW_MS = 90_000;
const GRAPH_AFFECTING_KINDS = new Set(["extract_metrics", "re_synthesize"]);

export type LabSelection =
  | { kind: "finding"; signature: string }
  | { kind: "paper"; refId: string }
  | null;

export type LabContextValue = {
  // Data.
  data: WebLatest | null;
  scheduler: SchedulerLatest | null;
  pipeline: ResearchPipeline | null;
  groups: GroupedFinding[];
  activity: number;
  reloadWeb: () => void;
  reloadPipeline: () => void;
  // Shared selection (bidirectional, cross-tab).
  selection: LabSelection;
  setSelection: (s: LabSelection) => void;
  selectedLibraryId: string | null;
  setSelectedLibraryId: (id: string | null) => void;
  // Portal access (registered by the Discovery shell while mounted).
  registerPortalApi: (api: PortalApi | null) => void;
  playThought: (candidateIndex: number) => void;
  fireLibraryCascade: (libraryId: string) => void;
  clearPortalSelection: () => void;
  emphasizeLibrary: (libraryId: string | null) => void;
  openPaper: (refId: string) => void;
  // Panel navigation (registered by whichever shell is mounted).
  registerPanelOpener: (fn: ((id: string) => void) | null) => void;
  openPanel: (id: string) => void;
  // Lab actions.
  building: boolean;
  rebuildWeb: () => Promise<void>;
  proposing: boolean;
  propose: () => Promise<void>;
  proposeOutcome: WebProposeOutcome | null;
  // Bot.
  botState: SchedulerBotState;
  setBotState: (s: SchedulerBotState) => void;
  // Ambient field intensity multiplier (dev-tunable).
  ambientActivityScale: number;
  setAmbientActivityScale: (x: number) => void;
  // The portal window's measured screen rect (Discovery's primary region).
  // The environment field clips itself to this box in focus mode so nothing
  // it draws (label sprites included) can escape into the header or dock.
  portalRect: { top: number; left: number; width: number; height: number } | null;
  setPortalRect: (r: { top: number; left: number; width: number; height: number } | null) => void;
  // The bot's voice: say() replaces the current bubble; speech is the live
  // utterance (id increments so equal text still re-triggers).
  speech: { id: number; text: string } | null;
  say: (text: string) => void;
  // Lookups.
  paperTitle: (refId: string) => string | null;
  communityLabel: (index: number) => string;
};

const LabContext = createContext<LabContextValue | null>(null);

export function useLab(): LabContextValue {
  const ctx = useContext(LabContext);
  if (!ctx) throw new Error("useLab must be used inside LabProvider");
  return ctx;
}

export function LabProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<WebLatest | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerLatest | null>(null);
  const [pipeline, setPipeline] = useState<ResearchPipeline | null>(null);
  const [activity, setActivity] = useState(ACTIVITY_IDLE);
  const [botState, setBotState] = useState<SchedulerBotState>("idle");
  const [selection, setSelectionState] = useState<LabSelection>(null);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [proposeOutcome, setProposeOutcome] = useState<WebProposeOutcome | null>(null);
  const [speech, setSpeech] = useState<{ id: number; text: string } | null>(null);
  const [ambientActivityScale, setAmbientActivityScale] = useState<number>(AMBIENT.activityScale);
  const [portalRect, setPortalRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const speechIdRef = useRef(0);
  const portalApiRef = useRef<PortalApi | null>(null);
  const panelOpenerRef = useRef<((id: string) => void) | null>(null);
  const prevTasksRef = useRef<Map<string, string> | null>(null);
  const prevGroupCountRef = useRef<number | null>(null);

  const say = useCallback((text: string) => {
    speechIdRef.current += 1;
    setSpeech({ id: speechIdRef.current, text });
  }, []);

  const loadWeb = useCallback(() => {
    fetch("/api/web/latest")
      .then((r) => r.json())
      .then((b: WebLatest) => setData(b))
      .catch(() => {});
  }, []);
  const loadPipeline = useCallback(() => {
    fetch("/api/research/pipeline")
      .then((r) => r.json())
      .then((b: ResearchPipeline) => {
        if (!("error" in b)) setPipeline(b);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadWeb();
    loadPipeline();
    const interval = window.setInterval(loadPipeline, PIPELINE_POLL_MS);
    return () => window.clearInterval(interval);
  }, [loadWeb, loadPipeline]);

  const groups = useMemo(() => groupAbcCandidates(data?.abc ?? []), [data]);
  const communities = data?.communities ?? [];
  const communityLabel = useCallback(
    (index: number) => communities.find((c) => c.index === index)?.label ?? `community ${index}`,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data],
  );

  // New-findings speech: fires when a reload increases the grouped count.
  useEffect(() => {
    const prev = prevGroupCountRef.current;
    if (prev !== null) {
      const line = newFindingsLine(prev, groups.length, groups[0] ?? null, communityLabel);
      if (line) say(line);
    }
    prevGroupCountRef.current = groups.length;
  }, [groups, communityLabel, say]);

  // Scheduler poll: activity, bot baseline, completion cascades, and the
  // bot's honest task-lifecycle lines (from observed status transitions).
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/scheduler/latest");
        const b = (await res.json()) as SchedulerLatest;
        if (cancelled || !b || "error" in b) return;
        setScheduler(b);
        const tasks = b.tasks ?? [];
        const executing = tasks.some((t) => t.status === "executing");
        const pending = tasks.some((t) => t.status === "queued" || t.status === "approved");
        const now = Date.now();
        const recentDone = tasks.some((t) => t.status === "completed" && t.completedAt && now - new Date(t.completedAt).getTime() < ACTIVITY_SURGE_WINDOW_MS);
        setActivity(recentDone ? 1 : executing ? ACTIVITY_EXECUTING : pending ? ACTIVITY_QUEUED : ACTIVITY_IDLE);
        setBotState((prev) => (prev === "idle" || prev === "loading" ? (executing ? "loading" : "idle") : prev));

        // Observed transitions become speech and cascades. First poll seeds
        // the baseline silently (no announcements for old history).
        const prev = prevTasksRef.current;
        if (prev) {
          for (const t of tasks) {
            const was = prev.get(t.id);
            if (was === t.status) continue;
            if (t.status === "executing") {
              say(taskStartLine(t.kind, t.scopeNames));
            } else if (t.status === "completed" && was === "executing") {
              const cr = t.commandResult;
              const rows = cr?.metricsOutcome && typeof cr.metricsOutcome === "object" ? Number((cr.metricsOutcome as { withMetrics?: number }).withMetrics ?? 0) || null : null;
              say(taskDoneLine(t.kind, t.scopeNames, cr?.elapsedMs ?? null, rows));
              if (GRAPH_AFFECTING_KINDS.has(t.kind)) {
                for (const libId of t.scopeIds ?? []) portalApiRef.current?.fireLibraryCascade(libId);
              }
              loadPipeline();
            } else if (t.status === "failed") {
              say(taskFailedLine(t.kind, t.scopeNames));
            }
          }
        }
        prevTasksRef.current = new Map(tasks.map((t) => [t.id, t.status]));
      } catch {
        // Scheduler unreachable: idle at the floor.
      }
    };
    void poll();
    const interval = window.setInterval(poll, SCHEDULER_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [say, loadPipeline]);

  const setSelection = useCallback((s: LabSelection) => {
    setSelectionState(s);
    if (s === null) portalApiRef.current?.clearSelection();
  }, []);

  const paperTitleBy = useMemo(() => new Map((data?.nodes ?? []).filter((n) => n.refId).map((n) => [n.refId!, n.label ?? n.refId!])), [data]);

  const rebuildWeb = useCallback(async () => {
    setBuilding(true);
    try {
      const res = await fetch("/api/web/build", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const b = await res.json();
      if (!res.ok) throw new Error(b.error ?? "The rebuild could not complete.");
      loadWeb();
      loadPipeline();
    } catch (e) {
      say(`web rebuild failed: ${(e as Error).message.slice(0, 80)}`);
    } finally {
      setBuilding(false);
    }
  }, [loadWeb, loadPipeline, say]);

  const propose = useCallback(async () => {
    setProposing(true);
    setProposeOutcome(null);
    try {
      const res = await fetch("/api/web/propose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const b = (await res.json()) as { error?: string; stage?: string; diagnostics?: WebProposeDiagnostics; proposed?: number; note?: string | null };
      if (!res.ok) {
        setProposeOutcome({
          kind: res.status === 422 ? "nothing" : "failed",
          message: b.error ?? "The proposal run failed without a reason (this is itself a bug).",
          stage: b.stage ?? null,
          proposed: null,
          note: null,
          diagnostics: b.diagnostics ?? null,
        });
        say(b.stage ? `the proposal run failed at ${b.stage}` : "the proposal run could not complete");
      } else {
        setProposeOutcome({
          kind: "completed",
          message: b.proposed && b.proposed > 0 ? `${b.proposed} crossover proposal${b.proposed === 1 ? "" : "s"} persisted.` : (b.note ?? "Completed with zero proposals."),
          stage: null,
          proposed: b.proposed ?? 0,
          note: b.note ?? null,
          diagnostics: b.diagnostics ?? null,
        });
        say(b.proposed && b.proposed > 0 ? `${b.proposed} proposal${b.proposed === 1 ? "" : "s"} persisted` : "proposal run finished, nothing met the bar");
        loadWeb();
      }
    } catch (e) {
      setProposeOutcome({ kind: "failed", message: (e as Error).message, stage: null, proposed: null, note: null, diagnostics: null });
    } finally {
      setProposing(false);
    }
  }, [loadWeb, say]);

  const value: LabContextValue = {
    data,
    scheduler,
    pipeline,
    groups,
    activity,
    reloadWeb: loadWeb,
    reloadPipeline: loadPipeline,
    selection,
    setSelection,
    selectedLibraryId,
    setSelectedLibraryId,
    registerPortalApi: (api) => {
      portalApiRef.current = api;
    },
    playThought: (i) => portalApiRef.current?.playThought(i),
    fireLibraryCascade: (id) => portalApiRef.current?.fireLibraryCascade(id),
    clearPortalSelection: () => portalApiRef.current?.clearSelection(),
    emphasizeLibrary: (libraryId) => portalApiRef.current?.emphasizeLibrary(libraryId),
    openPaper: (refId: string) => window.open(`/?paper=${refId}`, "_self"),
    registerPanelOpener: (fn) => {
      panelOpenerRef.current = fn;
    },
    openPanel: (id: string) => panelOpenerRef.current?.(id),
    building,
    rebuildWeb,
    proposing,
    propose,
    proposeOutcome,
    botState,
    setBotState,
    ambientActivityScale,
    setAmbientActivityScale,
    portalRect,
    setPortalRect,
    speech,
    say,
    paperTitle: (refId: string) => paperTitleBy.get(refId) ?? null,
    communityLabel,
  };

  return <LabContext.Provider value={value}>{children}</LabContext.Provider>;
}
