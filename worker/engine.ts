import type { Run, RunStatus, Step, StepLog, Trigger, Workflow } from "../shared/schema";
import { cronMatches, nextFire, parseCron } from "../shared/cron";
import { LIMITS } from "../shared/limits";
import type { Db, Filter } from "mongodb";
import { giveBack, underLimit } from "./auth";
import { chargeRunBytes, runBytes, STORAGE_FULL, STORAGE_HIGH, takeRunSlot } from "./db";
import { DEMO_USER_ID, resetDemo } from "./demo";
import { type Collections, ensureIndexes, type LogDoc, newRunId, type RunDoc } from "./mongo";
import { compile, type Op } from "./program";
import { loadSecrets, redactor, secretRefs } from "./secrets";
import { DEMO_HOSTS, evaluateIf, executeStep, formatSeconds, type LoopFrame, loopItems, type Scope, type StepResult } from "./steps";

/**
 * The engine. A run moves forward one step at a time and saves its place after every step, so
 * nothing is lost if the Worker stops. Steps inside `if` and `loop` blocks are flattened into one list
 * first (worker/program.ts), so the place is still a single number. When a step fails it is retried later with backoff; a delay
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
/** Longest log message and run error kept, in UTF-8 bytes. Both show up in lists, so they stay short. */
const MAX_MESSAGE = 1_000;
const MAX_ERROR = 1_000;
/** Due runs one tick moves forward, and how many at once. The rest wait for the next minute. */
const DUE_PER_TICK = 10;
/** At most this many of one account's runs per tick, so one account can't take every slot. */
const DUE_PER_OWNER = 2;
/** When the database is nearly full: pending runs an account may hold before they're stopped ahead of old history ... */
const BIG_BACKLOG = 21;
/** ... and after it. */
const SHRINK_BACKLOG_FROM = 5;
/** When the database is nearly full, each account's newest finished runs kept until last. */
const HISTORY_KEPT_PER_ACCOUNT = 50;
/** Accounts whose older history one check trims (those with the most first): one query each. */
const HISTORY_OWNERS_PER_CHECK = 5;
/** Older history left after a trim for the guard to leave everyone's oldest runs for the next check. */
const HISTORY_MORE_FROM = 100;
/** Accounts over the mark the guard counts, to know how much older history is left. */
const HISTORY_ACCOUNTS_COUNTED = 2_000;
/** Most runs the storage guard stops, or deletes, in one step of one check. */
const SHRINK_PER_CHECK = 2_000;
const TICK_CONCURRENCY = 3;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MB = 1024 * 1024;
/** The free cluster holds 512 MB. Past the first mark old runs are pruned; past the second, new runs and sign-ups pause. */
const STORAGE_WATCH_BYTES = 250 * MB;
const STORAGE_PRUNE_BYTES = 350 * MB;
const STORAGE_FULL_BYTES = 450 * MB;

const expiry = (from: number) => new Date(from + LIMITS.runHistoryDays * DAY);

type WorkflowRef = Pick<Workflow, "id" | "name" | "steps" | "workspaceId"> & { ownerId: string };

export async function createRun(
  c: Collections,
  wf: WorkflowRef,
  triggerType: Trigger["type"],
  input: unknown,
  /** For "Run again": the run whose input this one reuses. */
  rerunOf?: string,
) {
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
    stepRuns: 0,
    ...(rerunOf ? { rerunOf } : {}),
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
    return { value: note, bytes: utf8Bytes(JSON.stringify(note)) };
  }
  // Sizes are UTF-8 bytes, as stored: a character can take up to 4.
  const bytes = utf8Bytes(text);
  if (bytes > max) {
    const preview = new TextDecoder().decode(new TextEncoder().encode(text).slice(0, max)).replace(/\uFFFD$/, "");
    return { value: { truncated: true, preview }, bytes: max + 40 };
  }
  return { value: JSON.parse(text), bytes };
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
/** Cuts text to at most `max` UTF-8 bytes (plus "…"), never through the middle of a character. */
export function clipBytes(text: string, max: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= max) return text;
  return `${new TextDecoder().decode(bytes.slice(0, max)).replace(/\uFFFD$/, "")}…`;
}
/**
 * About the most a log entry adds: a 1 KB message, a 1 KB output preview and names. (JSON escaping can
 * add more; what's really written is charged when the run gives back its reservation.)
 */
const LOG_MAX_BYTES = 2_500;
/** How soon a run paused for lack of byte budget tries again (or at the next hour, if sooner). */
const PAUSE_RETRY_MS = 10 * 60_000;
/** About what a log entry adds to its run. */
const logBytes = (log: LogDoc) => utf8Bytes(JSON.stringify(log));

/** `note` says why the run is where it is (e.g. paused); the workflow list shows it. */
async function updateLastRun(
  c: Collections,
  run: Pick<RunDoc, "_id" | "workflowId">,
  status: Run["status"],
  note: string | null = null,
) {
  await c.workflows.updateOne(
    { _id: run.workflowId, "lastRun.id": run._id },
    note === null
      ? { $set: { "lastRun.status": status }, $unset: { "lastRun.error": "" } }
      : { $set: { "lastRun.status": status, "lastRun.error": note } },
  );
}

async function failRun(c: Collections, run: Pick<RunDoc, "_id" | "workflowId">, error: string) {
  await c.runs.updateOne(
    { _id: run._id },
    {
      $set: {
        status: "failed",
        error: clipBytes(error, MAX_ERROR),
        leaseUntil: null,
        nextRunAt: null,
        finishedAt: Date.now(),
      },
    },
  );
  await updateLastRun(c, run, "failed");
}

/**
 * Move a run forward as far as it can go right now. Never throws. `pepper` (AUTH_PEPPER) decrypts the
 * workspace secrets the run uses; without it, steps that name a secret fail.
 */
export async function advance(c: Collections, runId: string, pepper = ""): Promise<void> {
  let run: Awaited<ReturnType<typeof claim>> = null;
  try {
    const started = Date.now();
    run = await claim(c, runId, started);
    if (!run) return;
    if (run.claims > MAX_CLAIMS) {
      await failRun(c, run, "The run stopped making progress, so Knotwork gave up on it");
      return;
    }
    await step(c, run, started, pepper);
  } catch (err) {
    console.error(`run ${runId}`, err);
    if (run) await failRun(c, run, "Knotwork hit an internal error while running this step").catch(() => {});
  }
}

/** A loop's output while it runs, as stored: the list and where the loop is in it. */
interface StoredFrame {
  items: unknown[];
  index: number;
  count: number;
}

const isFrame = (value: unknown): value is StoredFrame =>
  typeof value === "object" && value !== null && Array.isArray((value as StoredFrame).items) && Number.isInteger((value as StoredFrame).index);

/** A loop's output as templates see it: with the current item, so `{{ loop.item }}` works. */
const withItem = (frame: StoredFrame): LoopFrame => ({ ...frame, item: frame.items[frame.index] });

async function step(c: Collections, run: RunDoc, started: number, pepper: string) {
  const ops = compile(run.steps);
  // Only the secrets this run's steps name are read and decrypted, and only when it names any.
  const refs = secretRefs(run.steps);
  const secrets = refs.size ? await loadSecrets(c, pepper, run.workspaceId, refs) : {};
  /** Hides secret values. Everything this run stores or passes on goes through it. */
  const clean = redactor(secrets);
  const scope: Scope = {
    trigger: run.input,
    steps: { ...run.outputs },
    run: { id: run._id, startedAt: new Date(run.createdAt).toISOString() },
    workflow: { id: run.workflowId, name: run.workflowName },
    secrets,
  };
  // Loops the run is in the middle of: give their outputs the current item back.
  for (const op of ops) {
    if (op.kind === "loop" && isFrame(scope.steps[op.step.id])) scope.steps[op.step.id] = withItem(scope.steps[op.step.id] as StoredFrame);
  }
  const frame = (loopId: string | undefined) => (loopId && isFrame(scope.steps[loopId]) ? (scope.steps[loopId] as LoopFrame) : undefined);

  let index = run.stepIndex;
  let attempt = run.attempt;
  let outputBytes = run.outputBytes;
  let stepRuns = run.stepRuns ?? 0;
  // Log ids only need to be unique and increasing within a run; an invocation logs at most
  // LIMITS.stepRunsPerRun lines, and the next one starts at least a millisecond later.
  let logId = started * 1000;

  type Place = { step: Step; loops: string[]; depth: number };
  const entry = (at: Place, status: StepLog["status"], startedAt: number, message: string | null, output?: unknown): LogDoc => {
    const pass = at.loops
      .map((id) => frame(id))
      .map((f) => (f ? `${f.index + 1} of ${f.count}` : ""))
      .filter(Boolean)
      .join(", ");
    return {
      id: logId++,
      stepId: at.step.id,
      stepName: at.step.name,
      stepType: at.step.type,
      attempt: attempt + 1,
      status,
      message: message === null ? null : clipBytes(clean(message), MAX_MESSAGE),
      output: keepable(clean(output), LOG_PREVIEW_BYTES).value,
      startedAt,
      durationMs: Date.now() - startedAt,
      ...(at.depth ? { depth: at.depth } : {}),
      ...(pass ? { pass } : {}),
    };
  };
  // A rerun is started by hand, so it counts with the on-demand runs even when it repeats a scheduled one.
  const pool = run.triggerType === "schedule" && !run.rerunOf ? "schedule" : "demand";
  // What this invocation stores (outputs, logs) counts against the hourly byte budgets. The most it
  // can store is reserved up front, in one charge, and what it didn't use is given back at the end.
  let used = 0;
  let logsCharged = 0;
  const pushLog = (log: LogDoc) => {
    // The run keeps its last MAX_LOGS lines, so lines past that replace older ones and add nothing.
    if (logsCharged++ < MAX_LOGS) used += logBytes(log);
    return { logs: { $each: [log], $slice: -MAX_LOGS } };
  };

  // A step inside a loop writes its output again on every pass, replacing the last one. What counts
  // toward the run's 64 KB is what is stored now, so a replaced output gives its bytes back.
  const sizes = new Map<string, number>();
  const sizeOf = (id: string) =>
    sizes.get(id) ?? (Object.hasOwn(run.outputs, id) ? utf8Bytes(JSON.stringify(run.outputs[id]) ?? "null") : 0);

  const finish = async (status: Run["status"], error: string | null, log?: LogDoc) => {
    await c.runs.updateOne(
      { _id: run._id },
      {
        $set: {
          status,
          error: error === null ? null : clipBytes(clean(error), MAX_ERROR),
          stepIndex: index,
          attempt,
          stepRuns,
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
  const park = async (nextRunAt: number, log?: LogDoc, note: string | null = null) => {
    await c.runs.updateOne(
      { _id: run._id },
      {
        $set: {
          status: "waiting",
          error: note,
          stepIndex: index,
          attempt,
          stepRuns,
          claims: 0,
          leaseUntil: null,
          nextRunAt,
          expiresAt: expiry(nextRunAt),
        },
        ...(log ? { $push: pushLog(log) } : {}),
      },
    );
    await updateLastRun(c, run, "waiting", note);
  };
  const options = run.ownerId === DEMO_USER_ID ? { allowHosts: DEMO_HOSTS } : {};

  // Without loops each step writes once. With them, the most the run can still write is what is left
  // of its step allowance.
  const writesLeft = ops.some((op) => op.kind === "loop")
    ? Math.max(1, LIMITS.stepRunsPerRun - stepRuns)
    : ops.length - index;
  const reserve =
    Math.max(0, Math.min(MAX_RUN_OUTPUT_BYTES + MAX_OUTPUT_BYTES - outputBytes, writesLeft * (MAX_OUTPUT_BYTES + 40))) +
    Math.min(writesLeft + 1, MAX_LOGS) * LOG_MAX_BYTES;
  const noRoom = await chargeRunBytes(c, run.ownerId, pool, reserve, started);
  if (noRoom) {
    // No step has run in this invocation yet, so nothing is repeated: the run waits, and says why. It
    // tries again in a few minutes (other runs in flight may give back what they reserved), and at the
    // latest when the next hour's budgets start.
    const retryAt = Math.min((Math.floor(started / HOUR) + 1) * HOUR, started + PAUSE_RETRY_MS);
    const at = new Date(retryAt).toISOString().slice(11, 16);
    const why = noRoom.startsWith("Your account")
      ? "this account's runs have stored their limit this hour"
      : "Knotwork's storage for runs is busy this hour";
    await park(retryAt, undefined, `Paused: ${why}. Tries again at ${at} UTC.`); // writes no log, so nothing to charge
    return;
  }
  try {
    await runSteps();
  } finally {
    // Settled in the hour the reservation was made, even if the invocation ran past the hour:
    // otherwise giving it back would credit the next hour's budgets.
    await chargeRunBytes(c, run.ownerId, pool, used - reserve, started, false);
  }

  /**
   * What one operation came to. `next` is where the run goes after an "ok"; `logged` is what the log
   * line shows when that isn't the stored output (a loop stores its list, the log shows the count).
   */
  type Outcome = StepResult & { next?: number; logged?: unknown };

  async function work(op: Exclude<Op, { kind: "jump" }>): Promise<Outcome> {
    // A step that names a secret nobody has set fails saying so, instead of sending an empty value.
    const missing = [...secretRefs(op.step.config)].filter((name) => !Object.hasOwn(secrets, name));
    if (missing.length) {
      return { kind: "fail", message: `The secret ${missing.join(", ")} isn't set in this workspace. Add it under Settings, then Secrets.` };
    }
    switch (op.kind) {
      case "step":
        return executeStep(op.step, scope, options);
      case "if": {
        const { passed, message } = evaluateIf(op.step, scope);
        return { kind: "ok", output: { result: passed, branch: passed ? "then" : "else" }, message, next: passed ? index + 1 : op.elseAt };
      }
      case "loop": {
        const list = loopItems(op.step, scope);
        if ("problem" in list) return { kind: "fail", message: list.problem };
        const count = list.items.length;
        if (count === 0) return { kind: "ok", output: { count }, message: "The list is empty, so there is nothing to go through", next: op.endAt };
        const stored: StoredFrame = { items: list.items, index: 0, count };
        return { kind: "ok", output: stored, logged: { count }, message: `Going through ${count} ${count === 1 ? "item" : "items"}`, next: index + 1 };
      }
      case "next": {
        const at = frame(op.step.id);
        if (!at) return { kind: "fail", message: "The loop lost its place" };
        if (at.index + 1 < at.count) {
          const stored: StoredFrame = { items: at.items, index: at.index + 1, count: at.count };
          return { kind: "ok", output: stored, next: op.bodyAt };
        }
        return { kind: "ok", output: { count: at.count }, next: index + 1 };
      }
    }
  }

  async function runSteps() {
    if (run.error) await c.runs.updateOne({ _id: run._id }, { $set: { error: null } }); // a pause note
    await updateLastRun(c, run, "running");

    while (index < ops.length) {
      const op = ops[index];
      if (op.kind === "jump") {
        index = op.to;
        continue;
      }
      if (Date.now() - started > TIME_BUDGET_MS) {
        // Out of time for this invocation: hand the run to the next tick.
        await park(Date.now());
        return;
      }

      const current = op.step;
      scope.loop = frame(op.loops.at(-1));
      const at = Date.now();
      if (stepRuns >= LIMITS.stepRunsPerRun) {
        await finish(
          "failed",
          `The run reached ${LIMITS.stepRunsPerRun} steps, the most one run can take (every pass of a loop counts)`,
          entry(op, "failed", at, "Too many steps"),
        );
        return;
      }

      let result: Outcome;
      try {
        result = await work(op);
      } catch (err) {
        result = { kind: "fail" as const, message: (err as Error).message || "The step crashed" };
      }

      switch (result.kind) {
        case "ok":
        case "wait": {
          const kept = keepable(clean(result.output));
          const looping = op.kind === "loop" || op.kind === "next";
          if (looping && isFrame(result.output) && !isFrame(kept.value)) {
            await finish(
              "failed",
              `${current.name}: the list is larger than ${MAX_OUTPUT_BYTES / 1000} KB, the most a loop can go through`,
              entry(op, "failed", at, "List too large"),
            );
            return;
          }
          const grow = kept.bytes - sizeOf(current.id);
          if (outputBytes + grow > MAX_RUN_OUTPUT_BYTES) {
            await finish(
              "failed",
              `${current.name}: the run's outputs passed ${MAX_RUN_OUTPUT_BYTES / 1000} KB`,
              entry(op, "failed", at, "Output too large"),
            );
            return;
          }
          outputBytes = Math.max(0, outputBytes + grow);
          sizes.set(current.id, kept.bytes);
          used += Math.max(0, grow);
          // Moving to the next item writes the loop's new place but no log line.
          const log =
            op.kind === "next"
              ? null
              : entry(op, result.kind === "ok" ? "ok" : "waiting", at, result.message ?? null, result.logged ?? kept.value);
          scope.steps[current.id] = looping && isFrame(kept.value) ? withItem(kept.value) : kept.value;
          index = result.kind === "ok" && result.next !== undefined ? result.next : index + 1;
          attempt = 0;
          stepRuns += 1;
          const set = { [`outputs.${current.id}`]: kept.value, outputBytes, stepIndex: index, attempt: 0, claims: 0, stepRuns };
          const push = log ? { $push: pushLog(log) } : {};
          if (result.kind === "wait") {
            const nextRunAt = Date.now() + result.seconds * 1000;
            await c.runs.updateOne(
              { _id: run._id },
              { $set: { ...set, status: "waiting", leaseUntil: null, nextRunAt, expiresAt: expiry(nextRunAt) }, ...push },
            );
            await updateLastRun(c, run, "waiting");
            return;
          }
          await c.runs.updateOne({ _id: run._id }, { $set: { ...set, leaseUntil: Date.now() + LEASE_MS }, ...push });
          break;
        }
        case "stop": {
          const log = entry(op, "stopped", at, result.message);
          index += 1;
          stepRuns += 1;
          await finish("stopped", null, log);
          return;
        }
        case "fail": {
          if (attempt < current.retry.max) {
            const wait = current.retry.backoffSeconds * 4 ** attempt;
            const message = `${result.message}. Trying again in ${formatSeconds(wait)} (${attempt + 1} of ${current.retry.max} retries)`;
            const log = entry(op, "retrying", at, message, result.output);
            attempt += 1;
            await park(Date.now() + wait * 1000, log);
          } else {
            await finish(
              "failed",
              `${current.name}: ${result.message}`,
              entry(op, "failed", at, result.message, result.output),
            );
          }
          return;
        }
      }
    }

    await finish("succeeded", null);
  }
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
/**
 * Stops up to SHRINK_PER_CHECK queued or waiting runs, from the accounts holding the most (at least
 * `from` each), and drops their bulky parts: input, step list, outputs and log. The run stays, small,
 * with the reason; its workflow shows it as stopped. Returns how many runs it stopped.
 */
async function shrinkBacklogs(c: Collections, now: number, from: number): Promise<number> {
  const backlogs = await c.runs
    .aggregate<{
      _id: string;
      n: number;
    }>([
      { $match: { status: { $in: ["queued", "waiting"] } } },
      { $group: { _id: "$ownerId", n: { $sum: 1 } } },
      { $match: { n: { $gte: from } } },
      { $sort: { n: -1 } },
      { $limit: 1_000 },
    ])
    .toArray();
  const owners: string[] = [];
  let total = 0;
  for (const b of backlogs) {
    if (total >= SHRINK_PER_CHECK) break;
    owners.push(b._id);
    total += b.n;
  }
  if (!owners.length) return 0;
  const pending = { ownerId: { $in: owners }, status: { $in: ["queued", "waiting"] as RunStatus[] } };
  const ids = (
    await c.runs
      .find(pending, { projection: { _id: 1 } })
      .limit(SHRINK_PER_CHECK)
      .toArray()
  ).map((r) => r._id);
  return shrinkRuns(c, now, ids, "this account had many runs waiting");
}

const FINISHED: RunStatus[] = ["succeeded", "failed", "stopped"];

/**
 * Deletes finished runs beyond each account's newest HISTORY_KEPT_PER_ACCOUNT, from the accounts with
 * the most history, so trimming old history costs every account its oldest runs before anyone loses
 * their recent ones. Returns how many runs it deleted.
 */
async function trimHistories(c: Collections): Promise<{ deleted: number; more: boolean }> {
  // Every account over the mark (most first), so what's left to trim afterwards is known.
  const heavy = await c.runs
    .aggregate<{
      _id: string;
      n: number;
    }>([{ $match: { status: { $in: FINISHED } } }, { $group: { _id: "$ownerId", n: { $sum: 1 } } }, { $match: { n: { $gt: HISTORY_KEPT_PER_ACCOUNT } } }, { $sort: { n: -1 } }, { $limit: HISTORY_ACCOUNTS_COUNTED }])
    .toArray();
  const surplus = heavy.reduce((sum, h) => sum + h.n - HISTORY_KEPT_PER_ACCOUNT, 0);
  const ids: string[] = [];
  for (const h of heavy.slice(0, HISTORY_OWNERS_PER_CHECK)) {
    if (ids.length >= SHRINK_PER_CHECK) break;
    // The account's oldest runs beyond its newest HISTORY_KEPT_PER_ACCOUNT.
    const extra = await c.runs
      .find({ ownerId: h._id, status: { $in: FINISHED } }, { projection: { _id: 1 } })
      .sort({ createdAt: 1 })
      .limit(Math.min(h.n - HISTORY_KEPT_PER_ACCOUNT, SHRINK_PER_CHECK - ids.length))
      .toArray();
    ids.push(...extra.map((r) => r._id));
  }
  if (ids.length) await c.runs.deleteMany({ _id: { $in: ids } });
  // More than a little older history left (one big account's, or many accounts') means the next check
  // keeps trimming before anyone's recent runs go. A few runs over 50 each don't count, so accounts
  // finishing a run a minute can't hold back the oldest-first step for good.
  return { deleted: ids.length, more: surplus - ids.length >= HISTORY_MORE_FROM };
}

/** Runs waiting more than a day ahead (long delays are what filling the database with waits needs), latest first. */
async function shrinkLongWaits(c: Collections, now: number): Promise<number> {
  const ids = await c.runs
    .find({ status: "waiting", nextRunAt: { $gt: now + DAY } }, { projection: { _id: 1 } })
    .sort({ nextRunAt: -1 })
    .limit(SHRINK_PER_CHECK)
    .toArray();
  return shrinkRuns(
    c,
    now,
    ids.map((r) => r._id),
    "this run was waiting more than a day ahead",
  );
}

async function shrinkRuns(c: Collections, now: number, ids: string[], why: string): Promise<number> {
  if (!ids.length) return 0;
  await c.runs.updateMany(
    { _id: { $in: ids }, status: { $in: ["queued", "waiting"] } },
    {
      $set: {
        status: "stopped",
        error: `Stopped to free space: Knotwork's free database was nearly full, and ${why}.`,
        finishedAt: now,
        nextRunAt: null,
        input: null,
        steps: [],
        outputs: {},
        outputBytes: 0,
        logs: [],
      },
    },
  );
  await c.workflows.updateMany(
    { "lastRun.id": { $in: ids } },
    { $set: { "lastRun.status": "stopped", "lastRun.error": "space" } },
  );
  return ids.length;
}

async function setStorageFlags(c: Collections, used: number, now: number) {
  // Above the watch mark, the cron checks every minute instead of every 10, so a burst can't fill
  // the rest of the space between two checks.
  if (used > STORAGE_WATCH_BYTES) {
    await c.counters.updateOne(
      { _id: STORAGE_HIGH },
      { $set: { n: 1, expiresAt: new Date(now + 15 * 60_000) } },
      { upsert: true },
    );
  } else {
    await c.counters.deleteOne({ _id: STORAGE_HIGH });
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
}

export async function guardStorage(c: Collections, db: Db, now: number) {
  // Atlas counts data plus indexes toward the 512 MB. (storageSize includes space freed by deletes,
  // which an M0 cluster can't compact, so it would never come back down.)
  const measure = async () => {
    const stats = (await db.stats()) as { dataSize?: number; indexSize?: number };
    return (stats.dataSize ?? 0) + (stats.indexSize ?? 0);
  };
  let used = await measure();
  const first = used;
  // The flags are set from the first measurement, before the slower steps below, so they hold even
  // if this invocation runs out of time; they're set again at the end.
  await setStorageFlags(c, used, now);
  if (used > STORAGE_PRUNE_BYTES) {
    // Waiting runs can't simply be deleted, so accounts could fill the space with them; but ordinary
    // in-flight work shouldn't pay for old history either. In order, measuring again after each step,
    // until there's room:
    //   1. shrink runs waiting more than a day ahead (long waits are what filling the space needs);
    //   2. shrink the pending runs of accounts holding far more than usual, biggest backlogs first;
    //   3. delete finished runs beyond each account's newest 50, the longest histories first;
    //   4. shrink the pending runs of accounts holding several, and
    //   5. delete everyone's oldest finished runs, both once less than 100 runs beyond anyone's newest 50
    //      are left to trim (or right away near the full mark);
    //   6. near the full mark, shrink any pending runs, the biggest backlogs first.
    // So many mid-sized backlogs can cost other accounts their older history, but not their recent runs.
    if (await shrinkLongWaits(c, now)) used = await measure();
    if (used > STORAGE_PRUNE_BYTES && (await shrinkBacklogs(c, now, BIG_BACKLOG))) used = await measure();
    let moreHistory = false;
    if (used > STORAGE_PRUNE_BYTES) {
      const trimmed = await trimHistories(c);
      moreHistory = trimmed.more;
      if (trimmed.deleted) used = await measure();
    }
    // While accounts still have history beyond their newest 50, the next check (a minute away) trims
    // that before anyone's runs in flight are stopped or anyone's recent runs go. Near the full mark
    // steps 4 and 5 run anyway, before step 6 stops every account's runs in flight.
    const historyDone = !moreHistory || used > STORAGE_FULL_BYTES;
    if (used > STORAGE_PRUNE_BYTES && historyDone && (await shrinkBacklogs(c, now, SHRINK_BACKLOG_FROM))) {
      used = await measure();
    }
    if (used > STORAGE_PRUNE_BYTES && historyDone) {
      const old = await c.runs
        .find({ status: { $in: FINISHED } }, { projection: { _id: 1 } })
        .sort({ createdAt: 1 })
        .limit(SHRINK_PER_CHECK)
        .toArray();
      if (old.length) {
        await c.runs.deleteMany({ _id: { $in: old.map((r) => r._id) } });
        used = await measure();
      }
    }
    if (used > STORAGE_FULL_BYTES && (await shrinkBacklogs(c, now, 1))) used = await measure();
  }
  if (first > STORAGE_PRUNE_BYTES) await setStorageFlags(c, used, now);
  return used;
}

/**
 * Runs every minute: fire schedules, resume parked runs, and once in a while look after the
 * database (storage, indexes) and reset the demo account.
 */
export async function tick(
  c: Collections,
  now = Date.now(),
  db?: Db,
  /** AUTH_PEPPER, for the demo reset's webhook keys. Without it the demo isn't reset. */
  pepper = "",
): Promise<{ scheduled: number; resumed: number }> {
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
      const blocked = await takeRunSlot(c, wf.ownerId, now, "schedule", runBytes(null, wf.steps));
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

  // Every 10 minutes, check how much of the free cluster is in use; every minute once it's high. Before
  // the due runs, so they can't use up this invocation's time first.
  if (
    db &&
    (minuteOfHour % 10 === 0 || (await c.counters.findOne({ _id: STORAGE_HIGH }, { projection: { _id: 1 } })))
  ) {
    await guardStorage(c, db, now).catch((err) => console.error("storage check", err));
  }

  const ready: Filter<RunDoc> = {
    $or: [
      { status: { $in: ["queued", "waiting"] }, nextRunAt: null },
      { status: { $in: ["queued", "waiting"] }, nextRunAt: { $lte: now } },
      { status: "running", leaseUntil: { $lt: now } },
    ],
  };
  // Accounts take turns, round robin: those the cron served longest ago (or never, in the last day)
  // go first, each with its oldest ready runs (at most DUE_PER_OWNER). Among accounts never served,
  // the order is shuffled each minute, so no account id is always last. A run that used up its time
  // in one invocation is parked with nextRunAt = now, so within an account it goes to the back of the
  // line. Slots nobody else needs go to the busy accounts, so a lone busy account still gets DUE_PER_TICK.
  const owners: string[] = await c.runs.distinct("ownerId", ready);
  const servedKey = (owner: string) => `cron-served:${owner}`;
  const lastServed = new Map<string, number>();
  if (owners.length > 1) {
    const docs = await c.counters.find({ _id: { $in: owners.map(servedKey) } }).toArray();
    for (const doc of docs) lastServed.set(doc._id, doc.n);
  }
  const shuffle = (owner: string) => {
    let h = minute / 60_000;
    for (let i = 0; i < owner.length; i++) h = (Math.imul(h, 31) + owner.charCodeAt(i)) | 0;
    return h;
  };
  const turn = owners
    .map((owner) => ({ owner, at: lastServed.get(servedKey(owner)) ?? 0, mix: shuffle(owner) }))
    .sort((a, b) => a.at - b.at || a.mix - b.mix)
    .slice(0, Math.ceil(DUE_PER_TICK / DUE_PER_OWNER))
    .map((t) => t.owner);
  const oldest = (filter: Filter<RunDoc>, limit: number) =>
    c.runs
      .find({ $and: [ready, filter] }, { projection: { _id: 1, ownerId: 1 } })
      .sort({ nextRunAt: 1 })
      .limit(limit)
      .toArray();
  const due = (await Promise.all(turn.map((owner) => oldest({ ownerId: owner }, DUE_PER_OWNER)))).flat();
  if (due.length < DUE_PER_TICK && owners.length) {
    due.push(...(await oldest({ _id: { $nin: due.map((r) => r._id) } }, DUE_PER_TICK - due.length)));
  }
  if (owners.length > 1 && due.length) {
    await c.counters.bulkWrite(
      [...new Set(due.map((r) => r.ownerId))].map((owner) => ({
        updateOne: {
          filter: { _id: servedKey(owner) },
          update: { $set: { n: minute, expiresAt: new Date(minute + DAY) } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  // A few at a time: they share one database connection, and the Worker one CPU budget.
  await inBatches(due, TICK_CONCURRENCY, (run) => advance(c, run._id, pepper));

  // Once an hour, make sure every index exists (a no-op when they do).
  if (minuteOfHour === 7) {
    const failed = await ensureIndexes(c).catch((err) => [String(err)]);
    if (failed.length) console.error("indexes", failed);
  }

  // Once a day, on the first tick from 03:00 UTC, put the shared demo account back the way it
  // started. The counter makes it once even if a tick is skipped or two overlap.
  if (pepper && new Date(minute).getUTCHours() >= 3 && (await underLimit(c, "demo-reset", DAY, 1, now))) {
    await resetDemo(c, now, pepper).catch(async (err) => {
      console.error("demo reset", err);
      await giveBack(c, "demo-reset", DAY, now);
    });
  }

  return { scheduled, resumed: due.length };
}
