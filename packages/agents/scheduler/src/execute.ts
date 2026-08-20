import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, libraries, schedulerRuns, schedulerTasks } from "@kazi-lab/db";
import type { TaskKind } from "./detection";

const here = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(here, "../..");

// Polite spacing between tasks so sequential agent runs never contend for the
// API. Documented default; not configurable per task in Phase 1.
const TASK_SPACING_MS = 5_000;
// stdout/stderr tails stored on the task; never the full verbose output.
const OUTPUT_TAIL_CHARS = 2_500;

const DEFAULT_TIMEOUT_S = 1_800;
function timeoutSecondsFor(kind: TaskKind): number {
  if (kind === "extract_metrics") {
    const env = Number(process.env.METRIC_EXTRACTION_TIMEOUT_SECONDS);
    return Number.isFinite(env) && env > 0 ? env : 3_600;
  }
  return DEFAULT_TIMEOUT_S;
}

// Every task kind maps to an existing agent CLI, spawned as a child process.
// The scheduler never imports agent logic (database-as-substrate: agents
// integrate through shared DB state); it invokes the same entry points the
// human runs by hand. args: library id or name per that CLI's convention.
type CommandSpec = { pkgDir: string; script: string; args: string[]; env?: Record<string, string> };

function commandsForTask(kind: TaskKind, scope: string[], scopeNames: string[]): CommandSpec[] {
  switch (kind) {
    case "extract_metrics":
      // One CLI invocation per library, by NAME. ONLY_MISSING keeps re-runs
      // idempotent and cheap (papers with metric rows are skipped).
      return scopeNames.map((name) => ({
        pkgDir: resolve(AGENTS_DIR, "scribe"),
        script: "src/extract-metrics-cli.ts",
        args: [name],
        env: { ONLY_MISSING: "1" },
      }));
    case "re_synthesize":
      return scope.map((libraryId) => ({
        pkgDir: resolve(AGENTS_DIR, "scribe"),
        script: "src/synthesize-cli.ts",
        args: [libraryId],
      }));
    case "re_critique":
      return scope.map((libraryId) => ({
        pkgDir: resolve(AGENTS_DIR, "critic"),
        script: "src/critique-cli.ts",
        args: [libraryId],
      }));
    case "extract_cross_domain":
      // The cross-domain CLI takes library NAMES (or none for all eligible).
      return [{ pkgDir: resolve(AGENTS_DIR, "lab"), script: "src/cross-domain-cli.ts", args: scopeNames }];
    case "propose_crossovers":
      return [{ pkgDir: resolve(AGENTS_DIR, "web"), script: "src/propose-cli.ts", args: [] }];
  }
}

// tsx binary: the scheduler's own devDependency, which runs any script in the
// workspace (imports resolve from the script file's location, so each agent's
// dependencies are found in its own package).
function tsxBin(): string {
  const own = resolve(here, "../node_modules/.bin/tsx");
  if (existsSync(own)) return own;
  const root = resolve(here, "../../../../node_modules/.bin/tsx");
  if (existsSync(root)) return root;
  throw new Error("tsx binary not found; run pnpm install");
}

type CommandOutcome = { ok: boolean; exitCode: number | null; tail: string; errorTail: string; timedOut: boolean };

function runCommand(spec: CommandSpec, timeoutMs: number): Promise<CommandOutcome> {
  return new Promise((resolvePromise) => {
    execFile(
      tsxBin(),
      [resolve(spec.pkgDir, spec.script), ...spec.args],
      {
        cwd: spec.pkgDir,
        env: { ...process.env, ...spec.env },
        timeout: timeoutMs,
        killSignal: "SIGTERM",
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error && "killed" in error && error.killed);
        resolvePromise({
          ok: !error,
          exitCode: error ? ((error as { code?: number }).code ?? null) : 0,
          tail: stdout.slice(-OUTPUT_TAIL_CHARS),
          errorTail: stderr.slice(-OUTPUT_TAIL_CHARS),
          timedOut,
        });
      },
    );
  });
}

export type TaskExecutionResult = {
  taskId: string;
  kind: string;
  scopeNames: string[];
  status: "completed" | "failed";
  elapsedMs: number;
  summary: string;
  error: string | null;
};

export type ExecutionReport = {
  runId: string;
  executed: number;
  failed: number;
  skipped: number; // approved tasks not run because the run was not found etc.
  results: TaskExecutionResult[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Stale-execution reaper: a task stuck in "executing" longer than its kind's
// timeout plus this margin was orphaned by a crashed or killed process. It is
// marked failed with a clear note so the queue can never be wedged forever.
const STALE_EXECUTION_MARGIN_S = 900;

// CONCURRENCY GUARD (database-level, not in memory). A task is claimed with a
// conditional transition: UPDATE ... WHERE status = 'approved' RETURNING.
// Exactly one concurrent caller can win the row; everyone else sees zero rows
// returned and skips. This is what prevents the double-execution that hit run
// b330c73d (a CLI run racing a UI click).
export async function claimTask(taskId: string): Promise<boolean> {
  const rows = await db
    .update(schedulerTasks)
    .set({ status: "executing", startedAt: new Date() })
    .where(and(eq(schedulerTasks.id, taskId), eq(schedulerTasks.status, "approved")))
    .returning({ id: schedulerTasks.id });
  return rows.length > 0;
}

// Run status is DERIVED from task statuses, never set optimistically: a run
// with any task still executing reports "executing" no matter which caller
// finished its own list first. Pure function, unit-tested.
export function deriveRunStatus(taskStatuses: string[]): "awaiting_approval" | "executing" | "completed" | "failed" {
  if (taskStatuses.some((s) => s === "executing")) return "executing";
  if (taskStatuses.some((s) => s === "queued" || s === "approved")) return "awaiting_approval";
  const terminal = taskStatuses.filter((s) => s === "completed" || s === "failed");
  if (terminal.length > 0 && terminal.every((s) => s === "failed")) return "failed";
  return "completed";
}

// Recompute and persist a run's status and counters from its tasks.
export async function syncRunStatus(runId: string): Promise<void> {
  const tasks = await db
    .select({ status: schedulerTasks.status })
    .from(schedulerTasks)
    .where(eq(schedulerTasks.runId, runId));
  const statuses = tasks.map((t) => t.status);
  await db
    .update(schedulerRuns)
    .set({
      status: deriveRunStatus(statuses),
      tasksExecuted: statuses.filter((s) => s === "completed").length,
      tasksFailed: statuses.filter((s) => s === "failed").length,
    })
    .where(eq(schedulerRuns.id, runId));
}

// Mark tasks stuck in "executing" beyond their timeout as failed, then bring
// their runs' derived status in step. Returns how many were reaped.
export async function reapStaleExecutions(): Promise<number> {
  const executing = await db.select().from(schedulerTasks).where(eq(schedulerTasks.status, "executing"));
  const now = Date.now();
  let reaped = 0;
  const touchedRuns = new Set<string>();
  for (const t of executing) {
    const limitMs = (timeoutSecondsFor(t.kind as TaskKind) + STALE_EXECUTION_MARGIN_S) * 1_000;
    const startedAt = t.startedAt?.getTime() ?? t.createdAt.getTime();
    if (now - startedAt > limitMs) {
      // Conditional again, so a task that just finished is not clobbered.
      const rows = await db
        .update(schedulerTasks)
        .set({
          status: "failed",
          completedAt: new Date(),
          commandResult: {
            ...(t.commandResult && typeof t.commandResult === "object" ? t.commandResult : {}),
            error: `stale execution reaped: still "executing" ${Math.round((now - startedAt) / 60_000)}m after start (limit ${Math.round(limitMs / 60_000)}m); the process likely crashed or was killed`,
          },
        })
        .where(and(eq(schedulerTasks.id, t.id), eq(schedulerTasks.status, "executing")))
        .returning({ id: schedulerTasks.id });
      if (rows.length > 0) {
        reaped += 1;
        touchedRuns.add(t.runId);
      }
    }
  }
  for (const runId of touchedRuns) await syncRunStatus(runId);
  return reaped;
}

// Execute the approved tasks on a run, sequentially, highest priority first.
// Every task is CLAIMED via the conditional transition above, so concurrent
// callers partition the work instead of duplicating it. The agent runs
// themselves are immutable snapshots with their own transactional writes; a
// failed task here cannot leave half an agent run behind, and completed agent
// work is deliberately NOT rolled back when a later task fails (undoing a
// finished, committed synthesis would destroy real results; the honest record
// is per-task status plus run counters).
export async function executeApprovedTasks(runIdArg?: string): Promise<ExecutionReport> {
  await reapStaleExecutions();
  let runId = runIdArg;
  if (!runId) {
    const [latest] = await db
      .select({ id: schedulerRuns.id })
      .from(schedulerRuns)
      .where(inArray(schedulerRuns.status, ["awaiting_approval", "executing"]))
      .orderBy(desc(schedulerRuns.createdAt))
      .limit(1);
    if (!latest) return { runId: "", executed: 0, failed: 0, skipped: 0, results: [] };
    runId = latest.id;
  }

  const approved = await db
    .select()
    .from(schedulerTasks)
    .where(and(eq(schedulerTasks.runId, runId), eq(schedulerTasks.status, "approved")))
    .orderBy(desc(schedulerTasks.priority), asc(schedulerTasks.createdAt));

  if (approved.length === 0) {
    return { runId, executed: 0, failed: 0, skipped: 0, results: [] };
  }

  await db.update(schedulerRuns).set({ status: "executing" }).where(eq(schedulerRuns.id, runId));

  // Resolve scope ids to names once (CLIs are name- or id-addressed).
  const allScopeIds = [...new Set(approved.flatMap((t) => t.scope))];
  const nameRows = allScopeIds.length
    ? await db.select({ id: libraries.id, name: libraries.name }).from(libraries).where(inArray(libraries.id, allScopeIds))
    : [];
  const nameBy = new Map(nameRows.map((r) => [r.id, r.name]));

  const results: TaskExecutionResult[] = [];
  let skippedByClaim = 0;
  let ranAny = false;
  for (const task of approved) {
    // The conditional claim: only one concurrent caller wins this row.
    if (!(await claimTask(task.id))) {
      skippedByClaim += 1;
      continue;
    }
    if (ranAny) await sleep(TASK_SPACING_MS);
    ranAny = true;
    const scopeNames = task.scope.map((id) => nameBy.get(id) ?? id);
    const startedAt = new Date();

    const kind = task.kind as TaskKind;
    const commands = commandsForTask(kind, task.scope, scopeNames);
    const timeoutMs = timeoutSecondsFor(kind) * 1_000;
    const perCommand: { ok: boolean; note: string }[] = [];
    let failedNote: string | null = null;
    let lastTail = "";
    for (const [ci, cmd] of commands.entries()) {
      if (ci > 0) await sleep(TASK_SPACING_MS);
      const out = await runCommand(cmd, timeoutMs);
      lastTail = out.tail;
      if (out.ok) {
        perCommand.push({ ok: true, note: `${cmd.script} ${cmd.args.join(" ")}` });
      } else {
        const why = out.timedOut
          ? `timed out after ${timeoutMs / 1_000}s`
          : `exit ${out.exitCode}: ${(out.errorTail || out.tail).slice(-600)}`;
        perCommand.push({ ok: false, note: `${cmd.script} ${cmd.args.join(" ")}: ${why}` });
        failedNote = why;
        break; // remaining commands of THIS task are skipped; later tasks still run
      }
    }

    const completedAt = new Date();
    const elapsedMs = completedAt.getTime() - startedAt.getTime();
    const status: "completed" | "failed" = failedNote ? "failed" : "completed";
    const summary = failedNote ? "" : lastTail.slice(-1_200);
    // Machine-readable metric outcome, when the CLI printed one (see
    // METRICS_OUTCOME_JSON in the scribe extract-metrics CLI): what was
    // scanned, what was found, and why zero is zero.
    const outcomeMatch = lastTail.match(/METRICS_OUTCOME_JSON:\s*(\{[^\n]*\})/);
    let metricsOutcome: Record<string, unknown> | null = null;
    if (outcomeMatch) {
      try {
        metricsOutcome = JSON.parse(outcomeMatch[1]) as Record<string, unknown>;
      } catch {
        metricsOutcome = null;
      }
    }
    await db
      .update(schedulerTasks)
      .set({
        status,
        completedAt,
        commandResult: {
          stage: "execution",
          scopeNames,
          commands: perCommand,
          elapsedMs,
          summary: summary || null,
          error: failedNote,
          metricsOutcome,
        },
      })
      .where(eq(schedulerTasks.id, task.id));
    results.push({
      taskId: task.id,
      kind: task.kind,
      scopeNames,
      status,
      elapsedMs,
      summary: summary ? summary.split("\n").slice(-8).join("\n") : "",
      error: failedNote,
    });
  }

  const executed = results.filter((r) => r.status === "completed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  // Derived, never optimistic: if another caller is still executing tasks on
  // this run, the run keeps reporting "executing".
  await syncRunStatus(runId);

  return { runId, executed, failed, skipped: skippedByClaim, results };
}
