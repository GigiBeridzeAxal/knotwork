import type { Run, RunDetail, Workflow, WorkflowInput, Workspace } from "../shared/schema";
import { LIMITS } from "../shared/limits";
import {
  type Collections,
  newHookKey,
  newWorkflowId,
  type RunDoc,
  type WorkflowDoc,
  type WorkspaceDoc,
} from "./mongo";

export const toWorkspace = (doc: WorkspaceDoc): Workspace => ({
  id: doc._id,
  name: doc.name,
  personal: doc.personal,
  createdAt: doc.createdAt,
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

/** The run fields the lists need. Logs, steps and outputs stay in the database. */
const RUN_SUMMARY = {
  _id: 1, workflowId: 1, workflowName: 1, status: 1, triggerType: 1, input: 1, stepIndex: 1,
  attempt: 1, nextRunAt: 1, error: 1, createdAt: 1, finishedAt: 1,
} as const;

export function toRun(doc: Pick<RunDoc, keyof typeof RUN_SUMMARY>): Run {
  return {
    id: doc._id,
    workflowId: doc.workflowId,
    workflowName: doc.workflowName,
    status: doc.status,
    triggerType: doc.triggerType,
    input: doc.input,
    stepIndex: doc.stepIndex,
    attempt: doc.attempt,
    nextRunAt: doc.nextRunAt,
    error: doc.error,
    createdAt: doc.createdAt,
    finishedAt: doc.finishedAt,
  };
}

// ---------- Workspaces ----------

export async function listWorkspaces(c: Collections, ownerId: string) {
  const docs = await c.workspaces.find({ ownerId }).sort({ personal: -1, createdAt: 1 }).toArray();
  return docs.map(toWorkspace);
}

/** Deletes a workspace with its workflows and runs. The personal workspace can't be deleted. */
export async function deleteWorkspace(c: Collections, id: string, ownerId: string): Promise<boolean> {
  const ws = await c.workspaces.findOne({ _id: id, ownerId });
  if (!ws || ws.personal) return false;
  await c.runs.deleteMany({ workspaceId: id });
  await c.workflows.deleteMany({ workspaceId: id });
  await c.workspaces.deleteOne({ _id: id });
  await c.sessions.updateMany({ userId: ownerId }, { $pull: { workspaceIds: id } });
  return true;
}

// ---------- Workflows ----------

export async function listWorkflows(c: Collections, workspaceId: string): Promise<Workflow[]> {
  const docs = await c.workflows.find({ workspaceId }).sort({ updatedAt: -1 }).limit(LIMITS.workflowsPerWorkspace * 2).toArray();
  return docs.map(toWorkflow);
}

export async function getWorkflow(c: Collections, id: string, workspaceId: string): Promise<Workflow | null> {
  const doc = await c.workflows.findOne({ _id: id, workspaceId });
  return doc ? toWorkflow(doc) : null;
}

export const countWorkflows = (c: Collections, workspaceId: string) => c.workflows.countDocuments({ workspaceId });

export async function insertWorkflow(
  c: Collections,
  workspaceId: string,
  ownerId: string,
  input: WorkflowInput,
  now: number,
): Promise<Workflow> {
  const doc: WorkflowDoc = {
    _id: newWorkflowId(),
    workspaceId,
    ownerId,
    ...input,
    hookKey: newHookKey(),
    version: 1,
    lastScheduledAt: null,
    lastRun: null,
    createdAt: now,
    updatedAt: now,
  };
  await c.workflows.insertOne(doc);
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

/** Why a new run may not start right now, or null when it may. */
export async function runBlocked(c: Collections, ownerId: string, now: number): Promise<string | null> {
  const since = { $gt: now - HOUR };
  const [mine, everyone] = await Promise.all([
    c.runs.countDocuments({ ownerId, createdAt: since }),
    c.runs.countDocuments({ createdAt: since }),
  ]);
  if (mine >= LIMITS.runsPerAccountPerHour) {
    return `Your account has started ${LIMITS.runsPerAccountPerHour} runs in the last hour, which is the limit. Try again later.`;
  }
  if (everyone >= LIMITS.runsPerHourOverall) return "Knotwork is busy right now. Try again in a few minutes.";
  return null;
}

export async function listRuns(c: Collections, workspaceId: string, workflowId: string | undefined, limit: number) {
  const filter = workflowId ? { workspaceId, workflowId } : { workspaceId };
  const docs = await c.runs.find(filter, { projection: RUN_SUMMARY }).sort({ createdAt: -1 }).limit(limit).toArray();
  return docs.map(toRun);
}

export async function getRun(c: Collections, id: string, workspaceId: string): Promise<RunDetail | null> {
  const doc = await c.runs.findOne({ _id: id, workspaceId }, { projection: { ...RUN_SUMMARY, logs: 1, steps: 1 } });
  if (!doc) return null;
  return { ...toRun(doc), logs: doc.logs, stepCount: doc.steps.length };
}
