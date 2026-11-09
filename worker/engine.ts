import type { Run, RunStatus, Step, StepLog, Trigger, Workflow } from "../shared/schema";
import { cronMatches, nextFire, parseCron } from "../shared/cron";
import { LIMITS } from "../shared/limits";
import type { Db, Filter } from "mongodb";
import { giveBack, underLimit } from "./auth";
import { STORAGE_FULL, takeRunSlot } from "./db";
import { DEMO_USER_ID, resetDemo } from "./demo";
import { type Collections, ensureIndexes, type LogDoc, newRunId, type RunDoc } from "./mongo";
import { clip, DEMO_HOSTS, executeStep, formatSeconds, type Scope } from "./steps";

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
const MAX_LOGS = 50;
/** Longest log message and run error kept. Both show up in lists, so they stay short. */
const MAX_MESSAGE = 1_000;
const MAX_ERROR = 1_000;
/** Due runs one tick moves forward, and how many at once. The rest wait for the next minute. */
const DUE_PER_TICK = 10;
/** At most this many of one account's runs per tick, so one account can't take every slot. */
const DUE_PER_OWNER = 2;
/** When the database is nearly full, accounts with more pending runs than this have them stopped. */
const STOP_BACKLOG_ABOVE = 20;
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
    // Ready now: the cron takes due runs in the order they became ready.
    nextRunAt: now,
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

/**
 * Take ownership of a run that is ready to move. Returns null when it isn't ready or someone else has
 * it. The claim itself is one atomic update; the run is then read without its logs, which the engine
 * never needs and which are the biggest part of a run.
 */
async function claim(c: Collections, runId: string, now: number) {
  const claimed = await c.runs.updateOne(
    {
      _id: runId,
      $or: [
        { status: { $in: ["queued", "waiting"] }, $or: [{ nextRunAt: null }, { nextRunAt: { $lte: now } }] },
        { status: "running", leaseUntil: { $lt: now } },
      ],
    },
    { $set: { status: "running", leaseUntil: now + LEASE_MS }, $inc: { claims: 1 } },
  );
  if (claimed.modifiedCount === 0) return null;
  return c.runs.findOne({ _id: runId }, { projection: { logs: 0 } });
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
    { $set: { status: "failed", error: clip(error, MAX_ERROR), leaseUntil: null, nextRunAt: null, finishedAt: Date.now() } },
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
    message: message === null ? null : clip(message, MAX_MESSAGE),
    output: keepable(output, LOG_PREVIEW_BYTES).value,
    startedAt: at,
    durationMs: Date.now() - at,
  });
  const pushLog = (log: LogDoc) => ({ logs: { $each: [log], $slice: -MAX_LOGS } });

  const finish = async (status: Run["status"], error: string | null, log?: LogDoc) => {
    await c.runs.updateOne(
      { _id: run._id },
      {
        $set: {
          status,
          error: error === null ? null : clip(error, MAX_ERROR),
          stepIndex: index,
          attempt,
          claims: 0,
          leaseUntil: null,
          nextRunAt: null,
          finishedAt: Date.now(),
        },
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
  // Atlas counts data plus indexes toward the 512 MB. (storageSize includes space freed by deletes,
  // which an M0 cluster can't compact, so it would never come back down.)
  const stats = (await db.stats()) as { dataSize?: number; indexSize?: number };
  const used = (stats.dataSize ?? 0) + (stats.indexSize ?? 0);
  if (used > STORAGE_PRUNE_BYTES) {
    const old = await c.runs
      .find({ status: { $in: ["succeeded", "failed", "stopped"] } }, { projection: { _id: 1 } })
      .sort({ createdAt: 1 })
      .limit(2_000)
      .toArray();
    if (old.length) await c.runs.deleteMany({ _id: { $in: old.map((r) => r._id) } });
    // Waiting runs can't be pruned, so a few accounts could fill the space with them. Stop the
    // pending runs of the (at most three) accounts holding many; they're deleted as finished runs
    // next time. Accounts with only a few in flight are left alone.
    const top = await c.runs
      .aggregate<{ _id: string }>([
        { $match: { status: { $in: ["queued", "waiting"] } } },
        { $group: { _id: "$ownerId", n: { $sum: 1 } } },
        { $match: { n: { $gt: STOP_BACKLOG_ABOVE } } },
        { $sort: { n: -1 } },
        { $limit: 3 },
      ])
      .toArray();
    if (old.length < 2_000 && top.length) {
      const pending = { ownerId: { $in: top.map((t) => t._id) }, status: { $in: ["queued", "waiting"] as RunStatus[] } };
      const ids = (await c.runs.find(pending, { projection: { _id: 1 } }).toArray()).map((r) => r._id);
      await c.runs.updateMany(
        { _id: { $in: ids }, status: { $in: ["queued", "waiting"] } },
        {
          $set: {
            status: "stopped",
            error: "Stopped to free space: Knotwork's free database was nearly full, and this account had the most runs waiting.",
            finishedAt: now,
            nextRunAt: null,
          },
        },
      );
      await c.workflows.updateMany({ "lastRun.id": { $in: ids } }, { $set: { "lastRun.status": "stopped" } });
    }
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

  // Only schedules due by this minute: each keeps the next minute it fires (nextFireAt), so the scan
  // skips the rest. A missing nextFireAt (new, edited or turned back on) is worked out here first.
  const schedules = await c.workflows
    .find(
      { "trigger.type": "schedule", enabled: true, $or: [{ nextFireAt: null }, { nextFireAt: { $lte: minute } }] },
      { projection: { _id: 1, trigger: 1, lastScheduledAt: 1, version: 1 } },
    )
    .toArray();

  // Each write below checks `version`, so a workflow saved since the scan (whose nextFireAt the save
  // reset) is left for the next tick instead of getting a time worked out from its old schedule.
  for (const { _id, trigger, lastScheduledAt, version } of schedules) {
    try {
      const cron = parseCron((trigger as Extract<Trigger, { type: "schedule" }>).cron);
      // Never firing again within a year (e.g. February 30th): look again in a day.
      const next = nextFire(cron, minute) ?? minute + DAY;
      if (!cronMatches(cron, new Date(minute)) || (lastScheduledAt ?? -1) >= minute) {
        await c.workflows.updateOne({ _id, version, nextFireAt: { $ne: next } }, { $set: { nextFireAt: next } });
        continue;
      }
      // Mark the minute first, so two ticks can never fire the same schedule twice.
      const wf = await c.workflows.findOneAndUpdate(
        { _id, version, $or: [{ lastScheduledAt: null }, { lastScheduledAt: { $lt: minute } }] },
        { $set: { lastScheduledAt: minute, nextFireAt: next } },
        { returnDocument: "after" },
      );
      if (!wf) continue;
      // A schedule that hits the account's hourly limit is skipped for this time; the log says why.
      const blocked = await takeRunSlot(c, wf.ownerId, now, "schedule");
      if (blocked) {
        console.log(`schedule ${_id} skipped: ${blocked}`);
        continue;
      }
      await createRun(c, { ...wf, id: wf._id }, "schedule", { scheduledFor: new Date(minute).toISOString() });
      scheduled += 1;
    } catch (err) {
      console.error(`schedule ${_id}`, err);
    }
  }

  const ready: Filter<RunDoc> = {
    $or: [
      { status: { $in: ["queued", "waiting"] }, nextRunAt: null },
      { status: { $in: ["queued", "waiting"] }, nextRunAt: { $lte: now } },
      { status: "running", leaseUntil: { $lt: now } },
    ],
  };
  // Accounts take turns: those the cron has served least this hour go first, each with its oldest
  // ready runs (at most DUE_PER_OWNER). A run that used up its time in one invocation is parked with
  // nextRunAt = now, so within an account it goes to the back of the line. Slots nobody else needs
  // go to the busy accounts, so a lone busy account still gets DUE_PER_TICK.
  const owners: string[] = await c.runs.distinct("ownerId", ready);
  const hour = Math.floor(now / 3_600_000);
  const servedKey = (owner: string) => `cron:${owner}:${hour}`;
  const served = new Map<string, number>();
  if (owners.length > 1) {
    const counts = await c.counters.find({ _id: { $in: owners.map(servedKey) } }).toArray();
    for (const doc of counts) served.set(doc._id, doc.n);
  }
  const turn = owners
    .map((owner) => ({ owner, n: served.get(servedKey(owner)) ?? 0 }))
    .sort((a, b) => a.n - b.n || (a.owner < b.owner ? -1 : 1))
    .slice(0, Math.ceil(DUE_PER_TICK / DUE_PER_OWNER))
    .map((t) => t.owner);
  const oldest = (filter: Filter<RunDoc>, limit: number) =>
    c.runs.find({ $and: [ready, filter] }, { projection: { _id: 1, ownerId: 1 } }).sort({ nextRunAt: 1 }).limit(limit).toArray();
  const due = (await Promise.all(turn.map((owner) => oldest({ ownerId: owner }, DUE_PER_OWNER)))).flat();
  if (due.length < DUE_PER_TICK && owners.length) {
    due.push(...(await oldest({ _id: { $nin: due.map((r) => r._id) } }, DUE_PER_TICK - due.length)));
  }
  if (owners.length > 1 && due.length) {
    const perOwner = new Map<string, number>();
    for (const run of due) perOwner.set(run.ownerId, (perOwner.get(run.ownerId) ?? 0) + 1);
    await c.counters.bulkWrite(
      [...perOwner].map(([owner, n]) => ({
        updateOne: {
          filter: { _id: servedKey(owner) },
          update: { $inc: { n }, $setOnInsert: { expiresAt: new Date((hour + 1) * 3_600_000) } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

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
