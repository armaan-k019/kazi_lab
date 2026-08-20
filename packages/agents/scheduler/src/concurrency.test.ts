import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

// Pure derivation tests (no database).
test("deriveRunStatus: executing tasks dominate; queues await; all-failed fails", async () => {
  const { deriveRunStatus } = await import("./execute");
  assert.equal(deriveRunStatus(["completed", "executing", "failed"]), "executing");
  assert.equal(deriveRunStatus(["completed", "queued"]), "awaiting_approval");
  assert.equal(deriveRunStatus(["completed", "approved"]), "awaiting_approval");
  assert.equal(deriveRunStatus(["failed", "failed"]), "failed");
  assert.equal(deriveRunStatus(["completed", "failed"]), "completed");
  assert.equal(deriveRunStatus(["completed", "rejected", "deferred"]), "completed");
});

// The concurrency guard, tested against the REAL database: two simulated
// concurrent callers race the conditional status transition on one approved
// task; exactly one may win. A scratch run is created and cascade-deleted.
test("claimTask: two concurrent callers, exactly one wins the row", async () => {
  const { db, schedulerRuns, schedulerTasks } = await import("@kazi-lab/db");
  const { eq } = await import("drizzle-orm");
  const { claimTask } = await import("./execute");

  const [run] = await db
    .insert(schedulerRuns)
    .values({ status: "awaiting_approval", notes: "concurrency-test scratch run (auto-deleted)" })
    .returning({ id: schedulerRuns.id });
  try {
    const [task] = await db
      .insert(schedulerTasks)
      .values({
        runId: run.id,
        kind: "extract_metrics",
        scope: [],
        priority: 6,
        costEstimateUsd: 0,
        costEstimateTokens: 0,
        status: "approved",
        approvalRequired: false,
      })
      .returning({ id: schedulerTasks.id });

    const [a, b] = await Promise.all([claimTask(task.id), claimTask(task.id)]);
    assert.equal(a !== b, true, `exactly one caller must win (got a=${a}, b=${b})`);

    // The loser cannot claim later either: the task is no longer approved.
    assert.equal(await claimTask(task.id), false);

    const [row] = await db.select({ status: schedulerTasks.status }).from(schedulerTasks).where(eq(schedulerTasks.id, task.id));
    assert.equal(row.status, "executing");
  } finally {
    await db.delete(schedulerRuns).where(eq(schedulerRuns.id, run.id)); // cascades to tasks
  }
});
