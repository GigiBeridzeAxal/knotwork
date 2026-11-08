import type { Run, Step, StepLog, Trigger, Workflow } from "../shared/schema";
import { cronMatches, parseCron } from "../shared/cron";
import { LIMITS } from "../shared/limits";
import { type Env, newRunId, recentRunCount, type RunRow } from "./db";
import { executeStep, formatSeconds, type Scope } from "./steps";

/**
 * The engine. A run moves forward one step at a time and saves its place in D1 after every step,
 * so nothing is lost if the Worker stops. When a step fails it is retried later with backoff;
 * a delay step parks the run. The cron trigger (every minute) wakes parked runs up again.
 */

/** A running run belongs to one invocation until this long after it was claimed. */
const LEASE_MS = 60_000;
/** Stop after this long in one invocation and let the next tick carry on. */
const TIME_BUDGET_MS = 25_000;
/** Runs and their logs are kept this long, which keeps the database inside the free plan. */
const RETENTION_MS = 14 * 24 * 3600 * 1000;
const MAX_OUTPUT_CHARS = 16_000;

export async function createRun(env: Env, workflow: Workflow, triggerType: Trigger["type"], input: unknown) {
  const id = newRunId();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO runs (id, workflow_id, status, trigger_type, input, steps, context, created_at)
     VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`,
  )
    .bind(id, workflow.id, triggerType, JSON.stringify(input ?? null), JSON.stringify(workflow.steps), JSON.stringify({ steps: {} }), now)
    .run();
  return id;
}

/** Take ownership of a run that is ready to move. Returns false when it isn't ready or someone else has it. */
async function claim(env: Env, runId: string, now: number): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE runs SET status = 'running', lease_until = ?
     WHERE id = ? AND (
       (status IN ('queued', 'waiting') AND (next_run_at IS NULL OR next_run_at <= ?))
       OR (status = 'running' AND lease_until < ?)
     )`,
  )
    .bind(now + LEASE_MS, runId, now, now)
    .run();
  return res.meta.changes > 0;
}

function trim(value: unknown): string | null {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return JSON.stringify({ truncated: true, preview: text.slice(0, MAX_OUTPUT_CHARS) });
}

/** Move a run forward as far as it can go right now. */
export async function advance(env: Env, runId: string): Promise<void> {
  const started = Date.now();
  if (!(await claim(env, runId, started))) return;

  const row = await env.DB.prepare(
    `SELECT r.*, w.name AS workflow_name FROM runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?`,
  )
    .bind(runId)
    .first<RunRow>();
  if (!row) return;

  const steps: Step[] = JSON.parse(row.steps);
  const context: { steps: Record<string, unknown> } = JSON.parse(row.context);
  const scope: Scope = {
    trigger: JSON.parse(row.input),
    steps: context.steps,
    run: { id: row.id, startedAt: new Date(row.created_at).toISOString() },
    workflow: { id: row.workflow_id, name: row.workflow_name ?? "" },
  };
  let index = row.step_index;
  let attempt = row.attempt;

  const log = (step: Step, status: StepLog["status"], at: number, message: string | null, output?: unknown) =>
    env.DB.prepare(
      `INSERT INTO step_logs (run_id, step_id, step_name, step_type, attempt, status, message, output, started_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(runId, step.id, step.name, step.type, attempt + 1, status, message, trim(output), at, Date.now() - at);

  const finish = (status: Run["status"], error: string | null) =>
    env.DB.prepare(
      `UPDATE runs SET status = ?, error = ?, step_index = ?, attempt = ?, context = ?, lease_until = NULL,
       next_run_at = NULL, finished_at = ? WHERE id = ?`,
    ).bind(status, error, index, attempt, JSON.stringify(context), Date.now(), runId);

  const park = (nextRunAt: number) =>
    env.DB.prepare(
      `UPDATE runs SET status = 'waiting', step_index = ?, attempt = ?, context = ?, lease_until = NULL,
       next_run_at = ? WHERE id = ?`,
    ).bind(index, attempt, JSON.stringify(context), nextRunAt, runId);

  while (index < steps.length) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      // Out of time for this invocation: hand the run to the next tick.
      await park(Date.now()).run();
      return;
    }

    const step = steps[index];
    const at = Date.now();
    let result;
    try {
      result = await executeStep(step, scope);
    } catch (err) {
      result = { kind: "fail" as const, message: (err as Error).message || "The step crashed" };
    }

    switch (result.kind) {
      case "ok": {
        context.steps[step.id] = result.output;
        const entry = log(step, "ok", at, result.message ?? null, result.output);
        index += 1;
        attempt = 0;
        await env.DB.batch([
          entry,
          env.DB.prepare(`UPDATE runs SET step_index = ?, attempt = 0, context = ?, lease_until = ? WHERE id = ?`).bind(
            index,
            JSON.stringify(context),
            Date.now() + LEASE_MS,
            runId,
          ),
        ]);
        break;
      }
      case "wait": {
        context.steps[step.id] = result.output;
        const entry = log(step, "waiting", at, result.message, result.output);
        index += 1;
        attempt = 0;
        await env.DB.batch([entry, park(Date.now() + result.seconds * 1000)]);
        return;
      }
      case "stop": {
        const entry = log(step, "stopped", at, result.message);
        index += 1;
        await env.DB.batch([entry, finish("stopped", null)]);
        return;
      }
      case "fail": {
        if (attempt < step.retry.max) {
          const wait = step.retry.backoffSeconds * 4 ** attempt;
          const message = `${result.message}. Trying again in ${formatSeconds(wait)} (${attempt + 1} of ${step.retry.max} retries)`;
          const entry = log(step, "retrying", at, message, result.output);
          attempt += 1;
          await env.DB.batch([entry, park(Date.now() + wait * 1000)]);
        } else {
          const entry = log(step, "failed", at, result.message, result.output);
          await env.DB.batch([entry, finish("failed", `${step.name}: ${result.message}`)]);
        }
        return;
      }
    }
  }

  await finish("succeeded", null).run();
}

/** Runs every minute: fire schedules, resume parked runs, and clear out old history. */
export async function tick(env: Env, now = Date.now()): Promise<{ scheduled: number; resumed: number }> {
  const minute = Math.floor(now / 60_000) * 60_000;
  let scheduled = 0;

  const { results: schedules } = await env.DB.prepare(
    `SELECT * FROM workflows WHERE enabled = 1 AND json_extract(trigger, '$.type') = 'schedule'
     AND (last_scheduled_at IS NULL OR last_scheduled_at < ?)`,
  )
    .bind(minute)
    .all<{ id: string; workspace_id: string; trigger: string; steps: string; name: string }>();

  for (const wf of schedules) {
    const trigger = JSON.parse(wf.trigger) as Extract<Trigger, { type: "schedule" }>;
    let matches = false;
    try {
      matches = cronMatches(parseCron(trigger.cron), new Date(minute));
    } catch {
      continue;
    }
    if (!matches) continue;
    if ((await recentRunCount(env.DB, wf.workspace_id, now)) >= LIMITS.runsPerWorkspacePerHour) continue;
    // Mark the minute first, so two ticks can never fire the same schedule twice.
    const marked = await env.DB.prepare(
      `UPDATE workflows SET last_scheduled_at = ? WHERE id = ? AND (last_scheduled_at IS NULL OR last_scheduled_at < ?)`,
    )
      .bind(minute, wf.id, minute)
      .run();
    if (marked.meta.changes === 0) continue;
    await createRun(env, { id: wf.id, steps: JSON.parse(wf.steps) } as Workflow, "schedule", {
      scheduledFor: new Date(minute).toISOString(),
    });
    scheduled += 1;
  }

  const { results: due } = await env.DB.prepare(
    `SELECT id FROM runs
     WHERE (status IN ('queued', 'waiting') AND (next_run_at IS NULL OR next_run_at <= ?))
        OR (status = 'running' AND lease_until < ?)
     ORDER BY created_at LIMIT 25`,
  )
    .bind(now, now)
    .all<{ id: string }>();

  await Promise.all(due.map((run) => advance(env, run.id)));

  const cutoff = now - RETENTION_MS;
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM step_logs WHERE run_id IN (SELECT id FROM runs WHERE created_at < ? AND finished_at IS NOT NULL)`,
    ).bind(cutoff),
    env.DB.prepare(`DELETE FROM runs WHERE created_at < ? AND finished_at IS NOT NULL`).bind(cutoff),
  ]);

  // Workflows nobody has edited or run for a long while are removed. Their runs are already gone
  // (runs only live 14 days), so a workflow with no runs left and an old updated_at is idle.
  const idleCutoff = now - LIMITS.idleWorkflowDays * 24 * 3600 * 1000;
  await env.DB.prepare(
    `DELETE FROM workflows WHERE updated_at < ? AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.workflow_id = workflows.id)`,
  )
    .bind(idleCutoff)
    .run();

  return { scheduled, resumed: due.length };
}
