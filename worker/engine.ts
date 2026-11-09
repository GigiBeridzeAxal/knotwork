import type { Run, Step, StepLog, Trigger, Workflow } from "../shared/schema";
import { cronMatches, parseCron } from "../shared/cron";
import { LIMITS } from "../shared/limits";
import type { Db } from "mongodb";
import { giveBack, underLimit } from "./auth";
import { STORAGE_FULL, takeRunSlot } from "./db";
import { DEMO_USER_ID, resetDemo } from "./demo";
import { type Collections, ensureIndexes, type LogDoc, newRunId, type RunDoc } from "./mongo";
import { DEMO_HOSTS, executeStep, formatSeconds, type Scope } from "./steps";

/**
 * The engine. A run moves forward one step at a time and saves its place after every step, so
 * nothing is lost if the Worker stops. When a step fails it is retried later with backoff; a delay
 * step parks the run. The cron trigger (every minute) wakes parked runs up again.
 *
 * One bad run must never stop the others: everything a run does after it is claimed is caught and
 * turns into that run failing, and the tick waits for runs with allSettled.
 */

/** A running run belongs to one invocation until this long after it was claimed. */
const LEASE_MS = 60_000;
/** Stop after this long in one invocation and let the next tick carry on. */
const TIME_BUDGET_MS = 25_000;
/** Claims in a row that end without saving progress before the run is given up on. */
const MAX_CLAIMS = 3;
/** Biggest single step output kept, and biggest total of all outputs in one run. */
const MAX_OUTPUT_BYTES = 16_000;
const MAX_RUN_OUTPUT_BYTES = 64_000;
/** A log line keeps only a preview of the step's output; the full output is in `outputs`. */
const LOG_PREVIEW_BYTES = 1_000;
const MAX_LOGS = 100;
/** Due runs one tick moves forward, and how many at once. */
const DUE_PER_TICK = 25;
const TICK_CONCURRENCY = 3;
const DAY = 86_400_000;
const MB = 1024 * 1024;
/** The free cluster holds 512 MB. Past the first mark old runs are pruned; past the second, new runs and sign-ups pause. */
const STORAGE_PRUNE_BYTES = 350 * MB;
const STORAGE_FULL_BYTES = 450 * MB;

const expiry = (from: number) => new Date(from + LIMITS.runHistoryDays * DAY);

type WorkflowRef = Pick<Workflow, "id" | "name" | "steps" | "workspaceId"> & { ownerId: string };

export async function createRun(c: Collections, wf: WorkflowRef, triggerType: Trigger["type"], input: unknown) {
  const now = Date.now();
  const run: RunDoc = {
    _id: newRunId(),
    workflowId: wf.id,
    workflowName: wf.name,
    workspaceId: wf.workspaceId,
    ownerId: wf.ownerId,
    status: "queued",
    triggerType,
    input: input ?? null,
    steps: wf.steps,
    outputs: {},
    outputBytes: 0,
    stepIndex: 0,
    attempt: 0,
    claims: 0,
    nextRunAt: null,
    leaseUntil: null,
    error: null,
    logs: [],
    createdAt: now,
    finishedAt: null,
    expiresAt: expiry(now),
  };
  await c.runs.insertOne(run);
  await c.workflows.updateOne({ _id: wf.id }, { $set: { lastRun: { id: run._id, status: "queued", createdAt: now } } });
  return run._id;
}

/** Take ownership of a run that is ready to move. Returns null when it isn't ready or someone else has it. */
async function claim(c: Collections, runId: string, now: number) {
  return c.runs.findOneAndUpdate(
    {
      _id: runId,
      $or: [
        { status: { $in: ["queued", "waiting"] }, $or: [{ nextRunAt: null }, { nextRunAt: { $lte: now } }] },
        { status: "running", leaseUntil: { $lt: now } },
      ],
    },
    { $set: { status: "running", leaseUntil: now + LEASE_MS }, $inc: { claims: 1 } },
    { returnDocument: "after" },
  );
}

/**
 * A copy of a step's output that is safe to keep: plain JSON, at most MAX_OUTPUT_BYTES. Anything that
 * can't be turned into JSON (a value that contains itself, a BigInt) becomes a short note instead.
 */
export function keepable(value: unknown, max = MAX_OUTPUT_BYTES): { value: unknown; bytes: number } {
  if (value === undefined) return { value: null, bytes: 4 };
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch (err) {
    const note = { unsaved: true, reason: `The output couldn't be saved: ${(err as Error).message}` };
    return { value: note, bytes: JSON.stringify(note).length };
  }
  if (text.length > max) {
    const cut = { truncated: true, preview: text.slice(0, max) };
    return { value: cut, bytes: max + 40 };
  }
  return { value: JSON.parse(text), bytes: text.length };
}

async function updateLastRun(c: Collections, run: Pick<RunDoc, "_id" | "workflowId">, status: Run["status"]) {
  await c.workflows.updateOne({ _id: run.workflowId, "lastRun.id": run._id }, { $set: { "lastRun.status": status } });
}

async function failRun(c: Collections, run: Pick<RunDoc, "_id" | "workflowId">, error: string) {
  await c.runs.updateOne(
    { _id: run._id },
    { $set: { status: "failed", error, leaseUntil: null, nextRunAt: null, finishedAt: Date.now() } },
  );
  await updateLastRun(c, run, "failed");
}

/** Move a run forward as far as it can go right now. Never throws. */
export async function advance(c: Collections, runId: string): Promise<void> {
  let run: Awaited<ReturnType<typeof claim>> = null;
  try {
    const started = Date.now();
    run = await claim(c, runId, started);
    if (!run) return;
    if (run.claims > MAX_CLAIMS) {
      await failRun(c, run, "The run stopped making progress, so Knotwork gave up on it");
      return;
    }
    await step(c, run, started);
  } catch (err) {
    console.error(`run ${runId}`, err);
    if (run) await failRun(c, run, "Knotwork hit an internal error while running this step").catch(() => {});
  }
}

async function step(c: Collections, run: RunDoc, started: number) {
  const steps = run.steps;
  const scope: Scope = {
    trigger: run.input,
    steps: { ...run.outputs },
    run: { id: run._id, startedAt: new Date(run.createdAt).toISOString() },
    workflow: { id: run.workflowId, name: run.workflowName },
  };
  let index = run.stepIndex;
  let attempt = run.attempt;
  let outputBytes = run.outputBytes;
  // Log ids only need to be unique and increasing within a run; one invocation logs fewer than 100.
  let logId = started * 100;

  const entry = (s: Step, status: StepLog["status"], at: number, message: string | null, output?: unknown): LogDoc => ({
    id: logId++,
    stepId: s.id,
    stepName: s.name,
    stepType: s.type,
    attempt: attempt + 1,
    status,
    message,
    output: keepable(output, LOG_PREVIEW_BYTES).value,
    startedAt: at,
    durationMs: Date.now() - at,
  });
  const pushLog = (log: LogDoc) => ({ logs: { $each: [log], $slice: -MAX_LOGS } });

  const finish = async (status: Run["status"], error: string | null, log?: LogDoc) => {
    await c.runs.updateOne(
      { _id: run._id },
      {
        $set: { status, error, stepIndex: index, attempt, claims: 0, leaseUntil: null, nextRunAt: null, finishedAt: Date.now() },
        ...(log ? { $push: pushLog(log) } : {}),
      },
    );
    await updateLastRun(c, run, status);
  };

  // A waiting run is kept for the full history period after it wakes up, so a week-long delay
  // can't outlive its own run.
  const park = async (nextRunAt: number, log?: LogDoc) => {
    await c.runs.updateOne(
      { _id: run._id },
      {
        $set: { status: "waiting", stepIndex: index, attempt, claims: 0, leaseUntil: null, nextRunAt, expiresAt: expiry(nextRunAt) },
        ...(log ? { $push: pushLog(log) } : {}),
      },
    );
    await updateLastRun(c, run, "waiting");
  };
  const options = run.ownerId === DEMO_USER_ID ? { allowHosts: DEMO_HOSTS } : {};

  await updateLastRun(c, run, "running");

  while (index < steps.length) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      // Out of time for this invocation: hand the run to the next tick.
      await park(Date.now());
      return;
    }

    const current = steps[index];
    const at = Date.now();
    let result;
    try {
      result = await executeStep(current, scope, options);
    } catch (err) {
      result = { kind: "fail" as const, message: (err as Error).message || "The step crashed" };
    }

    switch (result.kind) {
      case "ok":
      case "wait": {
        const kept = keepable(result.output);
        outputBytes += kept.bytes;
        if (outputBytes > MAX_RUN_OUTPUT_BYTES) {
          await finish("failed", `${current.name}: the run's outputs passed ${MAX_RUN_OUTPUT_BYTES / 1000} KB`, entry(current, "failed", at, "Output too large"));
          return;
        }
        scope.steps[current.id] = kept.value;
        const log = entry(current, result.kind === "ok" ? "ok" : "waiting", at, result.message ?? null, kept.value);
        index += 1;
        attempt = 0;
        const set = { [`outputs.${current.id}`]: kept.value, outputBytes, stepIndex: index, attempt: 0, claims: 0 };
        if (result.kind === "wait") {
          const nextRunAt = Date.now() + result.seconds * 1000;
          await c.runs.updateOne(
            { _id: run._id },
            { $set: { ...set, status: "waiting", leaseUntil: null, nextRunAt, expiresAt: expiry(nextRunAt) }, $push: pushLog(log) },
          );
          await updateLastRun(c, run, "waiting");
          return;
        }
        await c.runs.updateOne({ _id: run._id }, { $set: { ...set, leaseUntil: Date.now() + LEASE_MS }, $push: pushLog(log) });
        break;
      }
      case "stop": {
        const log = entry(current, "stopped", at, result.message);
        index += 1;
        await finish("stopped", null, log);
        return;
      }
      case "fail": {
        if (attempt < current.retry.max) {
          const wait = current.retry.backoffSeconds * 4 ** attempt;
          const message = `${result.message}. Trying again in ${formatSeconds(wait)} (${attempt + 1} of ${current.retry.max} retries)`;
          const log = entry(current, "retrying", at, message, result.output);
          attempt += 1;
          await park(Date.now() + wait * 1000, log);
        } else {
          await finish("failed", `${current.name}: ${result.message}`, entry(current, "failed", at, result.message, result.output));
        }
        return;
      }
    }
  }

  await finish("succeeded", null);
}

/** Runs `work` over `items`, at most `limit` at a time. */
async function inBatches<T>(items: T[], limit: number, work: (item: T) => Promise<unknown>) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++]).catch(() => {});
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/**
 * Keeps the database inside the free cluster's 512 MB. Past STORAGE_PRUNE_BYTES the oldest finished
 * runs go first; past STORAGE_FULL_BYTES new runs and sign-ups pause until the next check.
 */
export async function guardStorage(c: Collections, db: Db, now: number) {
  const stats = (await db.stats()) as { dataSize?: number; storageSize?: number; indexSize?: number };
  const used = Math.max(stats.dataSize ?? 0, stats.storageSize ?? 0) + (stats.indexSize ?? 0);
  if (used > STORAGE_PRUNE_BYTES) {
    const old = await c.runs
      .find({ status: { $in: ["succeeded", "failed", "stopped"] } }, { projection: { _id: 1 } })
      .sort({ createdAt: 1 })
      .limit(2_000)
      .toArray();
    if (old.length) await c.runs.deleteMany({ _id: { $in: old.map((r) => r._id) } });
  }
  if (used > STORAGE_FULL_BYTES) {
    // Lasts until a little after the next check, which renews it while the database stays full.
    await c.counters.updateOne(
      { _id: STORAGE_FULL },
      { $set: { n: 1, expiresAt: new Date(now + 15 * 60_000) } },
      { upsert: true },
    );
  } else {
    await c.counters.deleteOne({ _id: STORAGE_FULL });
  }
  return used;
}

/**
 * Runs every minute: fire schedules, resume parked runs, and once in a while look after the
 * database (storage, indexes) and reset the demo account.
 */
export async function tick(c: Collections, now = Date.now(), db?: Db): Promise<{ scheduled: number; resumed: number }> {
  const minute = Math.floor(now / 60_000) * 60_000;
  const minuteOfHour = new Date(minute).getUTCMinutes();
  let scheduled = 0;

  // Only schedules this minute could fire: never marked, or marked before this minute.
  const schedules = await c.workflows
    .find(
      {
        "trigger.type": "schedule",
        enabled: true,
        $or: [{ lastScheduledAt: null }, { lastScheduledAt: { $lt: minute } }],
      },
      { projection: { _id: 1, name: 1, workspaceId: 1, ownerId: 1, trigger: 1, steps: 1 } },
    )
    .toArray();

  for (const wf of schedules) {
    try {
      const trigger = wf.trigger as Extract<Trigger, { type: "schedule" }>;
      if (!cronMatches(parseCron(trigger.cron), new Date(minute))) continue;
      // Mark the minute first, so two ticks can never fire the same schedule twice.
      const marked = await c.workflows.updateOne(
        { _id: wf._id, $or: [{ lastScheduledAt: null }, { lastScheduledAt: { $lt: minute } }] },
        { $set: { lastScheduledAt: minute } },
      );
      if (marked.modifiedCount === 0) continue;
      if (await takeRunSlot(c, wf.ownerId, now)) continue;
      await createRun(c, { ...wf, id: wf._id }, "schedule", { scheduledFor: new Date(minute).toISOString() });
      scheduled += 1;
    } catch (err) {
      console.error(`schedule ${wf._id}`, err);
    }
  }

  const due = await c.runs
    .find(
      {
        $or: [
          { status: { $in: ["queued", "waiting"] }, nextRunAt: null },
          { status: { $in: ["queued", "waiting"] }, nextRunAt: { $lte: now } },
          { status: "running", leaseUntil: { $lt: now } },
        ],
      },
      { projection: { _id: 1 } },
    )
    .sort({ createdAt: 1 })
    .limit(DUE_PER_TICK)
    .toArray();

  // A few at a time: they share one database connection, and the Worker one CPU budget.
  await inBatches(due, TICK_CONCURRENCY, (run) => advance(c, run._id));

  // Every 10 minutes, check how much of the free cluster is in use.
  if (db && minuteOfHour % 10 === 0) {
    await guardStorage(c, db, now).catch((err) => console.error("storage check", err));
  }

  // Once an hour, make sure every index exists (a no-op when they do).
  if (minuteOfHour === 7) {
    const failed = await ensureIndexes(c).catch((err) => [String(err)]);
    if (failed.length) console.error("indexes", failed);
  }

  // Once a day, on the first tick from 03:00 UTC, put the shared demo account back the way it
  // started. The counter makes it once even if a tick is skipped or two overlap.
  if (new Date(minute).getUTCHours() >= 3 && (await underLimit(c, "demo-reset", DAY, 1, now))) {
    await resetDemo(c, now).catch(async (err) => {
      console.error("demo reset", err);
      await giveBack(c, "demo-reset", DAY, now);
    });
  }

  return { scheduled, resumed: due.length };
}
