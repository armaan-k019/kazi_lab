"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { SchedulerBotState, SchedulerLatest, SchedulerTaskView } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";

// How long success/error is held on the bot before easing back to idle.
const BOT_RESULT_HOLD_MS = 3000;

const KIND_LABEL: Record<string, string> = {
  extract_metrics: "extract metrics",
  re_synthesize: "re-synthesize",
  re_critique: "re-critique",
  extract_cross_domain: "cross-domain synthesis",
  propose_crossovers: "propose crossovers",
};

function statusColor(status: string): string {
  if (status === "completed") return "#6fb08a";
  if (status === "failed") return "#b4493b";
  if (status === "executing") return "#7da2d9";
  if (status === "approved") return "var(--accent)";
  if (status === "deferred" || status === "rejected") return "var(--text-muted)";
  return "#b07a4f"; // queued: awaiting a human decision
}

export function SchedulerView({ onBotState }: { onBotState?: (s: SchedulerBotState) => void }) {
  const [data, setData] = useState<SchedulerLatest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"detect" | "execute" | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const botHoldRef = useRef<number | null>(null);

  const setBot = useCallback(
    (s: SchedulerBotState) => {
      if (botHoldRef.current !== null) {
        window.clearTimeout(botHoldRef.current);
        botHoldRef.current = null;
      }
      onBotState?.(s);
      if (s === "success" || s === "error") {
        botHoldRef.current = window.setTimeout(() => onBotState?.("idle"), BOT_RESULT_HOLD_MS);
      }
    },
    [onBotState],
  );

  const load = useCallback(() => {
    setError(null);
    fetch("/api/scheduler/latest")
      .then((r) => r.json())
      .then((b: SchedulerLatest) => setData(b))
      .catch(() => setError("Could not load the scheduler state."));
  }, []);
  useEffect(() => {
    load();
    return () => {
      if (botHoldRef.current !== null) window.clearTimeout(botHoldRef.current);
    };
  }, [load]);

  const runDetection = async () => {
    setBusy("detect");
    setBot("thinking");
    setError(null);
    try {
      const res = await fetch("/api/scheduler/detect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const b = await res.json();
      if (!res.ok) throw new Error(b.error ?? "Detection failed without a reason.");
      load();
      setBot("idle");
    } catch (e) {
      setError((e as Error).message);
      setBot("error");
    } finally {
      setBusy(null);
    }
  };

  const executeApproved = async () => {
    if (!data?.run) return;
    setBusy("execute");
    setBot("loading");
    setError(null);
    try {
      const res = await fetch("/api/scheduler/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: data.run.id }) });
      const b = await res.json();
      if (!res.ok) throw new Error(b.error ?? "Execution failed without a reason.");
      load();
      setBot(b.failed > 0 ? "error" : "success");
    } catch (e) {
      setError((e as Error).message);
      setBot("error");
    } finally {
      setBusy(null);
    }
  };

  const act = async (action: "approve" | "defer" | "reject", taskId?: string, all?: boolean) => {
    setError(null);
    try {
      const res = await fetch("/api/scheduler/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(all ? { action, all: true, runId: data?.run?.id } : { action, taskId }),
      });
      const b = await res.json();
      if (!res.ok) throw new Error(b.error ?? `Could not ${action}.`);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const run = data?.run ?? null;
  const tasks = data?.tasks ?? [];
  const queued = tasks.filter((t) => t.status === "queued");
  const approved = tasks.filter((t) => t.status === "approved");
  const finished = tasks.filter((t) => t.status === "completed" || t.status === "failed");
  const totalCost = tasks
    .filter((t) => t.status !== "rejected" && t.status !== "deferred")
    .reduce((s, t) => s + t.costEstimateUsd, 0);
  const stats = run?.stats ?? null;

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: "easeOut" }}>
      <h2 className="text-2xl font-semibold tracking-tight text-text-primary">Scheduler</h2>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-text-muted">
        The lab detecting what to do. Deterministic detection over the corpus state queues actionable
        tasks with conservative cost estimates; you approve every consequential move before anything
        runs. Detection asserts nothing and calls no model.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={runDetection} disabled={busy !== null} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50">
          {busy === "detect" ? "Detecting…" : "Run detection now"}
        </button>
        <button type="button" onClick={executeApproved} disabled={busy !== null || approved.length === 0} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-default disabled:opacity-50">
          {busy === "execute" ? "Executing…" : `Execute approved (${approved.length})`}
        </button>
        {queued.length > 0 && (
          <>
            <button type="button" onClick={() => act("approve", undefined, true)} disabled={busy !== null} className="rounded-lg border border-border px-3 py-2 text-[13px] text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50">
              Approve all
            </button>
            <button type="button" onClick={() => act("defer", undefined, true)} disabled={busy !== null} className="rounded-lg border border-border px-3 py-2 text-[13px] text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50">
              Defer all
            </button>
          </>
        )}
        {busy && <span className="flex items-center gap-2 text-[13px] text-text-secondary"><Spinner /> {busy === "execute" ? "running approved tasks, this can take a while…" : "detecting…"}</span>}
      </div>

      {error && <p className="mt-4 text-[13px] text-[#b4493b]">{error}</p>}

      {data && !run && (
        <p className="mt-8 max-w-md text-[15px] leading-relaxed text-text-muted">
          No detection pass yet. Run detection to see what the lab thinks needs doing.
        </p>
      )}

      {run && (
        <>
          {/* Detection status. */}
          <div className="mt-6 rounded-xl border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ color: statusColor(run.status === "awaiting_approval" ? "queued" : run.status), backgroundColor: "var(--surface-raised)" }}>
                {run.status.replace("_", " ")}
              </span>
              <span className="text-[12px] text-text-muted">
                last detection {formatRelativeTime(run.createdAt)} · {run.tasksQueued} task{run.tasksQueued === 1 ? "" : "s"} queued · ~${totalCost.toFixed(2)} estimated (upper bound)
              </span>
            </div>
            {stats && (
              <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">
                {stats.totalLibraries} libraries ({stats.synthesizedLibraries} synthesized, {stats.librariesWithMetrics} with metrics) ·
                stale items: {stats.synthesisStale} synthesis, {stats.metricsMissing} metrics
                {stats.crossDomainMissing > 0 ? ", cross-domain aging" : ""}
                {stats.proposalsMissing > 0 ? ", proposals missing" : ""}
                {stats.apiFailures24h > 0 ? ` · ${stats.apiFailures24h} agent failure${stats.apiFailures24h === 1 ? "" : "s"} in 24h` : ""}
              </p>
            )}
            {run.notes && <p className="mt-1 text-[12px] text-text-muted">{run.notes}</p>}
            <div className="mt-2">
              <button type="button" onClick={() => setShowDiagnostics((s) => !s)} className="text-[11px] text-text-muted underline-offset-2 hover:text-text-secondary hover:underline">
                {showDiagnostics ? "hide diagnostics" : `view diagnostics (${data?.diagnostics.length ?? 0})`}
              </button>
              {showDiagnostics && (
                <ul className="mt-2 space-y-1 border-t border-border pt-2">
                  {(data?.diagnostics ?? []).map((d) => (
                    <li key={d.id} className="font-mono text-[11px] leading-relaxed text-text-secondary">
                      <span className="text-[#b07a4f]">{d.kind}</span>
                      {d.libraryName && <span className="text-text-primary"> {d.libraryName}</span>}
                      <span className="text-text-muted"> · {JSON.stringify(d.details)}</span>
                    </li>
                  ))}
                  {(data?.diagnostics.length ?? 0) === 0 && <li className="text-[11px] text-text-muted">no diagnostics on this run</li>}
                </ul>
              )}
            </div>
          </div>

          {/* Task queue. */}
          <div className="mt-4 space-y-2">
            {tasks.length === 0 && <p className="text-[13px] text-text-muted">Nothing to do. The corpus is current.</p>}
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} busy={busy !== null} onAct={(a) => act(a, t.id)} />
            ))}
          </div>

          {/* Execution log. */}
          {finished.length > 0 && (
            <div className="mt-6">
              <h3 className="text-[13px] font-semibold uppercase tracking-wide text-text-secondary">Execution log</h3>
              <div className="mt-2 space-y-2">
                {finished.map((t) => (
                  <div key={t.id} className="rounded-lg border border-border bg-surface p-3">
                    <p className="text-[12px] text-text-primary">
                      <span style={{ color: statusColor(t.status) }}>[{t.status}]</span> {KIND_LABEL[t.kind] ?? t.kind} {t.scopeNames.join(", ")}
                      {typeof t.commandResult?.elapsedMs === "number" && <span className="text-text-muted"> · {Math.round(t.commandResult.elapsedMs / 1000)}s</span>}
                    </p>
                    {t.commandResult?.error && <p className="mt-1 font-mono text-[11px] leading-relaxed text-[#b4493b]">{t.commandResult.error}</p>}
                    {t.commandResult?.summary && (
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-text-muted">{t.commandResult.summary}</pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </motion.div>
  );
}

function TaskRow({ task, busy, onAct }: { task: SchedulerTaskView; busy: boolean; onAct: (action: "approve" | "defer" | "reject") => void }) {
  const reason = task.commandResult?.reason;
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ color: statusColor(task.status), backgroundColor: "var(--surface-raised)" }}>
          {task.status}
        </span>
        <span className="text-[13px] font-medium text-text-primary">{KIND_LABEL[task.kind] ?? task.kind}</span>
        {task.scopeNames.length > 0 && <span className="text-[12px] text-text-secondary">{task.scopeNames.join(", ")}</span>}
        <span className="font-mono text-[11px] text-text-muted">p{task.priority} · ~${task.costEstimateUsd.toFixed(2)} · ~{Math.round(task.costEstimateTokens / 1000)}k tok</span>
        {!task.approvalRequired && <span className="text-[11px] text-text-muted">auto-approved</span>}
        {task.status === "queued" && (
          <span className="ml-auto flex gap-1.5">
            <button type="button" disabled={busy} onClick={() => onAct("approve")} className="rounded border border-accent/40 px-2 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent-dim disabled:opacity-50">
              Approve
            </button>
            <button type="button" disabled={busy} onClick={() => onAct("defer")} className="rounded border border-border px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-accent/30 disabled:opacity-50">
              Defer
            </button>
            <button type="button" disabled={busy} onClick={() => onAct("reject")} className="rounded border border-border px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-[#b4493b]/50 hover:text-[#b4493b] disabled:opacity-50">
              Reject
            </button>
          </span>
        )}
      </div>
      {reason && <p className="mt-1 text-[12px] leading-relaxed text-text-muted">{reason}</p>}
      {task.humanApprovalBy && task.status !== "queued" && <p className="mt-0.5 text-[11px] text-text-muted">{task.humanApprovalBy}{task.humanApprovalAt ? ` · ${formatRelativeTime(task.humanApprovalAt)}` : ""}</p>}
    </div>
  );
}

function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden="true" />;
}
