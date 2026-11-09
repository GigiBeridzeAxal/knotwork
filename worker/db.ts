import type { Role, Run, RunDetail, Workflow, WorkflowInput, WorkflowSummary, Workspace } from "../shared/schema";
import { LIMITS } from "../shared/limits";
import { bump, giveBack } from "./auth";
import { DEMO_USER_ID } from "./demo";
import {
  type Collections,
  newWorkflowId,
  type RunDoc,
  type WorkflowDoc,
  type WorkspaceDoc,
} from "./mongo";

export const toWorkspace = (doc: WorkspaceDoc, role: Role = "owner"): Workspace => ({
  id: doc._id,
  name: doc.name,
  personal: doc.personal,
  createdAt: doc.createdAt,
  role,
});

export function toWorkflow(doc: WorkflowDoc): Workflow {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    name: doc.name,
    description: doc.description,
    enabled: doc.enabled,
    trigger: doc.trigger,
    steps: doc.steps,
    hookKey: doc.hookKey,
    version: doc.version,
    lastRun: doc.lastRun ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** A workflow as lists show it: steps without their settings, which only the editor needs. */
export function toSummary(doc: WorkflowDoc): WorkflowSummary {
  const { steps, ...rest } = toWorkflow(doc);
  return { ...rest, steps: steps.map((s) => ({ id: s.id, name: s.name, type: s.type })) };
}

const SUMMARY_FIELDS = {
  _id: 1, workspaceId: 1, name: 1, description: 1, enabled: 1, trigger: 1, hookKey: 1, version: 1,
  lastRun: 1, createdAt: 1, updatedAt: 1, "steps.id": 1, "steps.name": 1, "steps.type": 1,
} as const;

/** The run fields the lists need. Input, logs, steps and outputs stay in the database. */
const RUN_SUMMARY = {
  _id: 1, workflowId: 1, workflowName: 1, status: 1, triggerType: 1, stepIndex: 1,
  attempt: 1, nextRunAt: 1, error: 1, createdAt: 1, finishedAt: 1,
} as const;

export function toRun(doc: Pick<RunDoc, keyof typeof RUN_SUMMARY>): Run {
  return {
    id: doc._id,
    workflowId: doc.workflowId,
    workflowName: doc.workflowName,
    status: doc.status,
    triggerType: doc.triggerType,
    stepIndex: doc.stepIndex,
    attempt: doc.attempt,
    nextRunAt: doc.nextRunAt,
    error: doc.error,
    createdAt: doc.createdAt,
    finishedAt: doc.finishedAt,
  };
}

// ---------- Workspaces ----------

/** Deletes a workspace with its workflows, runs, members, invite links and API keys. The personal one can't be deleted. */
export async function deleteWorkspace(c: Collections, id: string, ownerId: string): Promise<boolean> {
  const ws = await c.workspaces.findOne({ _id: id, ownerId });
  if (!ws || ws.personal) return false;
  // Other people's ways in go first (members, invite links, API keys), then the data.
  await Promise.all([c.members.deleteMany({ workspaceId: id }), c.invites.deleteMany({ workspaceId: id }), c.apiKeys.deleteMany({ workspaceId: id })]);
  await c.runs.deleteMany({ workspaceId: id });
  await c.workflows.deleteMany({ workspaceId: id });
  await c.workspaces.deleteOne({ _id: id });
  await c.sessions.updateMany({ userId: ownerId }, { $pull: { workspaceIds: id } });
  return true;
}

// ---------- Workflows ----------

export async function listWorkflows(c: Collections, workspaceId: string): Promise<WorkflowSummary[]> {
  const docs = await c.workflows
    .find({ workspaceId }, { projection: SUMMARY_FIELDS })
    .sort({ updatedAt: -1 })
    .limit(LIMITS.workflowsPerWorkspace)
    .toArray();
  return docs.map(toSummary);
}

export async function getWorkflow(c: Collections, id: string, workspaceId: string): Promise<Workflow | null> {
  const doc = await c.workflows.findOne({ _id: id, workspaceId });
  return doc ? toWorkflow(doc) : null;
}

/**
 * Adds a workflow if the workspace has room. Two saves at once could both pass a count taken first,
 * so the workflow is inserted, then counted, and taken out again if it went over the limit or the
 * workspace was deleted in the meantime. (Two saves into the last free place at the same moment can
 * then both be refused; that errs on the safe side, and trying again works.)
 */
export async function insertWorkflow(
  c: Collections,
  workspaceId: string,
  ownerId: string,
  input: WorkflowInput,
  now: number,
  /** From `newHookKey(pepper)`. */
  hookKey: string,
): Promise<Workflow | "full" | "gone"> {
  const doc: WorkflowDoc = {
    _id: newWorkflowId(),
    workspaceId,
    ownerId,
    ...input,
    hookKey,
    version: 1,
    lastScheduledAt: null,
    nextFireAt: null,
    lastRun: null,
    createdAt: now,
    updatedAt: now,
  };
  await c.workflows.insertOne(doc);
  const [count, workspace] = await Promise.all([
    c.workflows.countDocuments({ workspaceId }),
    c.workspaces.findOne({ _id: workspaceId }, { projection: { _id: 1 } }),
  ]);
  if (count > LIMITS.workflowsPerWorkspace || !workspace) {
    await c.workflows.deleteOne({ _id: doc._id });
    return workspace ? "full" : "gone";
  }
  return toWorkflow(doc);
}

export type UpdateResult = { ok: true; workflow: Workflow } | { ok: false; reason: "missing" } | { ok: false; reason: "stale"; current: Workflow };

/** Saves only if nobody saved since `version` was loaded; otherwise reports the newer copy. */
export async function updateWorkflow(
  c: Collections,
  id: string,
  workspaceId: string,
  input: WorkflowInput,
  version: number,
  now: number,
): Promise<UpdateResult> {
  const doc = await c.workflows.findOneAndUpdate(
    { _id: id, workspaceId, version },
    {
      $set: {
        name: input.name,
        description: input.description,
        enabled: input.enabled,
        trigger: input.trigger,
        steps: input.steps,
        // The schedule may have changed or been turned back on; the next tick works out when it fires.
        nextFireAt: null,
        updatedAt: now,
      },
      $inc: { version: 1 },
    },
    { returnDocument: "after" },
  );
  if (doc) return { ok: true, workflow: toWorkflow(doc) };
  const current = await getWorkflow(c, id, workspaceId);
  return current ? { ok: false, reason: "stale", current } : { ok: false, reason: "missing" };
}

export async function deleteWorkflow(c: Collections, id: string, workspaceId: string): Promise<boolean> {
  const res = await c.workflows.deleteOne({ _id: id, workspaceId });
  if (res.deletedCount === 0) return false;
  await c.runs.deleteMany({ workflowId: id });
  return true;
}

// ---------- Runs ----------

const HOUR = 3_600_000;
/** Set by the cron tick while the database is close to the free cluster's 512 MB. */
export const STORAGE_FULL = "storage:full";
/** Set by the cron tick while the database is above its watch mark: it then checks every minute. */
export const STORAGE_HIGH = "storage:high";
export const runCounter = (ownerId: string) => `runs:${ownerId}`;

export const storageFull = async (c: Collections) => (await c.counters.findOne({ _id: STORAGE_FULL })) !== null;

/**
 * How many runs an account may start per clock hour: fewer in its first 24 hours, so a batch of fresh
 * sign-ups can't use up everyone's runs. Null when the account no longer exists (its workflows were
 * left behind by a deletion that was cut off), so they can't run. The demo has no date: full budget.
 */
export async function runLimit(c: Collections, ownerId: string, now: number): Promise<number | null> {
  if (ownerId === DEMO_USER_ID) return LIMITS.runsPerAccountPerHour;
  const user = await c.users.findOne({ _id: ownerId }, { projection: { createdAt: 1 } });
  if (!user) return null;
  return now - user.createdAt < 24 * HOUR ? LIMITS.newAccountRunsPerHour : LIMITS.runsPerAccountPerHour;
}

/**
 * Takes one run from the account's and everyone's budget for this clock hour. Returns why the run
 * may not start, or null when it may. The counters are atomic, so parallel requests can't overshoot.
 */
export async function takeRunSlot(
  c: Collections,
  ownerId: string,
  now: number,
  kind: "schedule" | "webhook" | "manual" = "manual",
  /** What the run will store up front (`runBytes`), counted against the hourly byte budgets. */
  bytes = 0,
): Promise<string | null> {
  const [full, max, pending] = await Promise.all([
    storageFull(c),
    runLimit(c, ownerId, now),
    c.runs.countDocuments({ ownerId, status: { $in: ["queued", "waiting"] } }, { limit: LIMITS.pendingRunsPerAccount }),
  ]);
  if (max === null) return "This workflow's account has been deleted.";
  // Runs that are waiting (a delay, a retry) can pile up over days; this keeps one account's backlog
  // small enough that the cron, and the database, keep up.
  if (pending >= LIMITS.pendingRunsPerAccount) {
    return `This account has ${LIMITS.pendingRunsPerAccount} runs waiting or queued, which is the most it can have. New runs can start once some of them finish.`;
  }
  const used = await bump(c, runCounter(ownerId), HOUR, now);
  const mine = used <= max;
  // A refused run gives its slot back, so the counter (shown as "runs this hour") counts started runs.
  if (full || !mine) await giveBack(c, runCounter(ownerId), HOUR, now);
  if (full) return "Knotwork's free database is nearly full, so new runs are paused for a few minutes.";
  if (!mine) {
    if (ownerId === DEMO_USER_ID) {
      return `The demo account is shared by everyone trying Knotwork and has used its ${LIMITS.runsPerAccountPerHour} runs this hour. Create a free account to get your own.`;
    }
    const young = max < LIMITS.runsPerAccountPerHour ? " (accounts get the full 60 after their first day)" : "";
    return `Your account has started ${max} runs this hour, which is the limit${young}. Try again after the hour turns.`;
  }
  // Scheduled runs are already limited per account and by the 5-minute minimum, so the shared ceiling
  // applies only to runs anyone can start on demand: webhooks and manual runs. That way a burst of
  // webhook calls can't stop everyone's schedules.
  if (kind !== "schedule") {
    const everyone = await bump(c, "runs:all", HOUR, now);
    // Past half of the shared ceiling, only accounts that have used little this hour get more, so a
    // handful of busy accounts can't use it all up for everyone else.
    const fair = everyone <= LIMITS.runsPerHourOverall / 2 || used <= LIMITS.fairShareRunsPerHour;
    if (everyone > LIMITS.runsPerHourOverall || !fair) {
      await Promise.all([giveBack(c, runCounter(ownerId), HOUR, now), giveBack(c, "runs:all", HOUR, now)]);
      const at = new Date((Math.floor(now / HOUR) + 1) * HOUR).toISOString().slice(11, 16);
      return everyone > LIMITS.runsPerHourOverall
        ? `Knotwork has started as many runs as it can this hour. New runs can start again at ${at} UTC.`
        : `Knotwork is busy this hour, and your account has already started ${LIMITS.fairShareRunsPerHour} runs, so new ones wait until ${at} UTC. Scheduled runs keep going.`;
    }
  }
  // Bytes: what the run stores up front (input and steps) counts against hourly byte budgets, and so
  // does everything it stores later (outputs, logs), so a burst can't fill the free cluster between
  // two storage checks.
  if (bytes > 0) {
    const noRoom = await chargeRunBytes(c, ownerId, kind === "schedule" ? "schedule" : "demand", bytes, now);
    if (noRoom) {
      await Promise.all([giveBack(c, runCounter(ownerId), HOUR, now), kind !== "schedule" ? giveBack(c, "runs:all", HOUR, now) : null]);
      return noRoom;
    }
  }
  return null;
}

/**
 * Counts `bytes` a run stores against its account's hourly budget and its pool's (scheduled runs
 * have their own, so a burst of webhook runs can't stop everyone's schedules, and the other way
 * round). Past half of a pool, accounts that stored more than their fair share this hour wait.
 * Returns why there's no room (and takes nothing), or null. With `enforce` false it only counts.
 */
export async function chargeRunBytes(
  c: Collections,
  ownerId: string,
  pool: "schedule" | "demand",
  bytes: number,
  now: number,
  enforce = true,
): Promise<string | null> {
  const poolKey = `runbytes:${pool}`;
  const cap = pool === "schedule" ? LIMITS.scheduleRunBytesPerHour : LIMITS.runBytesPerHourOverall;
  const [mine, all] = await Promise.all([bump(c, `runbytes:${ownerId}`, HOUR, now, bytes), bump(c, poolKey, HOUR, now, bytes)]);
  if (!enforce) return null;
  // The fair share looks at what the account had stored before this charge, so one run's reservation
  // alone can't put an account over it.
  const fair = all <= cap / 2 || mine - bytes <= LIMITS.fairShareRunBytesPerHour;
  if (mine <= LIMITS.runBytesPerAccountPerHour && all <= cap && fair) return null;
  await Promise.all([bump(c, `runbytes:${ownerId}`, HOUR, now, -bytes), bump(c, poolKey, HOUR, now, -bytes)]);
  const at = new Date((Math.floor(now / HOUR) + 1) * HOUR).toISOString().slice(11, 16);
  if (mine > LIMITS.runBytesPerAccountPerHour) {
    return `Your account's runs have stored their ${LIMITS.runBytesPerAccountPerHour / 1_000_000} MB this hour. New runs can start at ${at} UTC.`;
  }
  if (all > cap) return `Knotwork's runs this hour have used the space it can give them. New runs can start at ${at} UTC.`;
  return `Knotwork is busy this hour, and your account's runs have already stored ${LIMITS.fairShareRunBytesPerHour / 1_000} KB, so new ones wait until ${at} UTC.`;
}

/** Bytes a run stores when it's created: its input and its copy of the steps. */
export function runBytes(input: unknown, steps: unknown): number {
  return new TextEncoder().encode(JSON.stringify([input ?? null, steps])).byteLength;
}

export async function listRuns(c: Collections, workspaceId: string, workflowId: string | undefined, limit: number) {
  const filter = workflowId ? { workspaceId, workflowId } : { workspaceId };
  const docs = await c.runs.find(filter, { projection: RUN_SUMMARY }).sort({ createdAt: -1 }).limit(limit).toArray();
  return docs.map(toRun);
}

export async function getRun(c: Collections, id: string, workspaceId: string): Promise<RunDetail | null> {
  const doc = await c.runs.findOne({ _id: id, workspaceId }, { projection: { ...RUN_SUMMARY, input: 1, logs: 1, "steps.id": 1 } });
  if (!doc) return null;
  return { ...toRun(doc), input: doc.input, logs: doc.logs, stepCount: doc.steps.length };
}
