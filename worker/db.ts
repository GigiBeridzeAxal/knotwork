import type { Run, RunStatus, Step, StepLog, Trigger, Workflow, WorkflowInput } from "../shared/schema";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

interface WorkflowRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  enabled: number;
  trigger: string;
  steps: string;
  hook_key: string;
  last_scheduled_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface RunRow {
  id: string;
  workflow_id: string;
  status: RunStatus;
  trigger_type: Trigger["type"];
  input: string;
  steps: string;
  context: string;
  step_index: number;
  attempt: number;
  next_run_at: number | null;
  lease_until: number | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
  workflow_name?: string;
}

interface LogRow {
  id: number;
  step_id: string;
  step_name: string;
  step_type: Step["type"];
  attempt: number;
  status: StepLog["status"];
  message: string | null;
  output: string | null;
  started_at: number;
  duration_ms: number;
}

const parse = (text: string | null): unknown => (text ? JSON.parse(text) : null);

export function toWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    trigger: JSON.parse(row.trigger),
    steps: JSON.parse(row.steps),
    hookKey: row.hook_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toRun(row: RunRow): Run {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    status: row.status,
    triggerType: row.trigger_type,
    input: parse(row.input),
    stepIndex: row.step_index,
    attempt: row.attempt,
    nextRunAt: row.next_run_at,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export function toLog(row: LogRow): StepLog {
  return {
    id: row.id,
    stepId: row.step_id,
    stepName: row.step_name,
    stepType: row.step_type,
    attempt: row.attempt,
    status: row.status,
    message: row.message,
    output: parse(row.output),
    startedAt: row.started_at,
    durationMs: row.duration_ms,
  };
}

function randomId(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const newWorkflowId = () => `wf_${randomId(8)}`;
export const newRunId = () => `run_${randomId(10)}`;
export const newHookKey = () => randomId(18);

export async function listWorkflows(db: D1Database, workspace: string) {
  const { results } = await db
    .prepare(
      `SELECT w.*, r.id AS last_run_id, r.status AS last_run_status, r.created_at AS last_run_at
       FROM workflows w
       LEFT JOIN runs r ON r.id = (
         SELECT id FROM runs WHERE workflow_id = w.id ORDER BY created_at DESC LIMIT 1
       )
       WHERE w.workspace_id = ?
       ORDER BY w.updated_at DESC`,
    )
    .bind(workspace)
    .all<WorkflowRow & { last_run_id: string | null; last_run_status: RunStatus | null; last_run_at: number | null }>();
  return results.map((row) => ({
    ...toWorkflow(row),
    lastRun: row.last_run_id
      ? { id: row.last_run_id, status: row.last_run_status!, createdAt: row.last_run_at! }
      : null,
  }));
}

export async function getWorkflow(db: D1Database, id: string, workspace: string): Promise<Workflow | null> {
  const row = await db
    .prepare("SELECT * FROM workflows WHERE id = ? AND workspace_id = ?")
    .bind(id, workspace)
    .first<WorkflowRow>();
  return row ? toWorkflow(row) : null;
}

export async function getWorkflowByHook(db: D1Database, hookKey: string): Promise<Workflow | null> {
  const row = await db.prepare("SELECT * FROM workflows WHERE hook_key = ?").bind(hookKey).first<WorkflowRow>();
  return row ? toWorkflow(row) : null;
}

export async function countWorkflows(db: D1Database, workspace: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM workflows WHERE workspace_id = ?")
    .bind(workspace)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Runs started in the last hour by every workflow in a workspace. */
export async function recentRunCount(db: D1Database, workspace: string, now: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM runs r JOIN workflows w ON w.id = r.workflow_id
       WHERE w.workspace_id = ? AND r.created_at > ?`,
    )
    .bind(workspace, now - 3600_000)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function insertWorkflow(
  db: D1Database,
  workspace: string,
  input: WorkflowInput,
  now: number,
): Promise<Workflow> {
  const id = newWorkflowId();
  await db
    .prepare(
      `INSERT INTO workflows (id, workspace_id, name, description, enabled, trigger, steps, hook_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      workspace,
      input.name,
      input.description,
      input.enabled ? 1 : 0,
      JSON.stringify(input.trigger),
      JSON.stringify(input.steps),
      newHookKey(),
      now,
      now,
    )
    .run();
  return (await getWorkflow(db, id, workspace))!;
}

export async function updateWorkflow(db: D1Database, id: string, workspace: string, input: WorkflowInput, now: number) {
  const res = await db
    .prepare(
      `UPDATE workflows SET name = ?, description = ?, enabled = ?, trigger = ?, steps = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    )
    .bind(
      input.name,
      input.description,
      input.enabled ? 1 : 0,
      JSON.stringify(input.trigger),
      JSON.stringify(input.steps),
      now,
      id,
      workspace,
    )
    .run();
  return res.meta.changes > 0 ? getWorkflow(db, id, workspace) : null;
}

export async function deleteWorkflow(db: D1Database, id: string, workspace: string): Promise<boolean> {
  if (!(await getWorkflow(db, id, workspace))) return false;
  const [, , res] = await db.batch([
    db.prepare("DELETE FROM step_logs WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = ?)").bind(id),
    db.prepare("DELETE FROM runs WHERE workflow_id = ?").bind(id),
    db.prepare("DELETE FROM workflows WHERE id = ?").bind(id),
  ]);
  return res.meta.changes > 0;
}

export async function listRuns(db: D1Database, workspace: string, workflowId: string | undefined, limit: number) {
  const base = `SELECT r.*, w.name AS workflow_name FROM runs r JOIN workflows w ON w.id = r.workflow_id
    WHERE w.workspace_id = ?`;
  const stmt = workflowId
    ? db.prepare(`${base} AND r.workflow_id = ? ORDER BY r.created_at DESC LIMIT ?`).bind(workspace, workflowId, limit)
    : db.prepare(`${base} ORDER BY r.created_at DESC LIMIT ?`).bind(workspace, limit);
  const { results } = await stmt.all<RunRow>();
  return results.map(toRun);
}

export async function getRunRow(db: D1Database, id: string, workspace: string): Promise<RunRow | null> {
  return db
    .prepare(
      `SELECT r.*, w.name AS workflow_name FROM runs r JOIN workflows w ON w.id = r.workflow_id
       WHERE r.id = ? AND w.workspace_id = ?`,
    )
    .bind(id, workspace)
    .first<RunRow>();
}

export async function getRunLogs(db: D1Database, runId: string): Promise<StepLog[]> {
  const { results } = await db.prepare("SELECT * FROM step_logs WHERE run_id = ? ORDER BY id").bind(runId).all<LogRow>();
  return results.map(toLog);
}
