import type { Run, RunDetail, Workflow, WorkflowInput, WorkflowSummary } from "../shared/schema";

const WORKSPACE_KEY = "knotwork.workspace";
const WORKSPACE = /^ws_[A-Za-z0-9_-]{16,40}$/;

function newWorkspaceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return "ws_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * There are no accounts: this browser's workspace id is the key to its workflows. A link with
 * `?workspace=` opens the same workspace somewhere else.
 */
function loadWorkspace(): string {
  const fromLink = new URLSearchParams(location.search).get("workspace");
  let stored = "";
  try {
    stored = localStorage.getItem(WORKSPACE_KEY) ?? "";
  } catch {
    // Storage blocked: this tab gets a workspace of its own.
  }
  const id = fromLink && WORKSPACE.test(fromLink) ? fromLink : WORKSPACE.test(stored) ? stored : newWorkspaceId();
  try {
    localStorage.setItem(WORKSPACE_KEY, id);
  } catch {
    // Same as above.
  }
  if (fromLink) history.replaceState(null, "", location.pathname);
  return id;
}

export const workspaceId = loadWorkspace();

export interface Issue {
  path: (string | number)[];
  message: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public issues: Issue[] = [],
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  headers.set("x-knotwork-workspace", workspaceId);
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.issues);
  return data as T;
}

export const api = {
  workflows: () => request<WorkflowSummary[]>("/workflows"),
  workflow: (id: string) => request<Workflow>(`/workflows/${id}`),
  createWorkflow: (input: WorkflowInput) =>
    request<Workflow>("/workflows", { method: "POST", body: JSON.stringify(input) }),
  updateWorkflow: (id: string, input: WorkflowInput) =>
    request<Workflow>(`/workflows/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteWorkflow: (id: string) => request<void>(`/workflows/${id}`, { method: "DELETE" }),
  runWorkflow: (id: string, input: unknown) =>
    request<{ runId: string }>(`/workflows/${id}/run`, { method: "POST", body: JSON.stringify({ input }) }),
  runs: (workflowId?: string) =>
    request<Run[]>(`/runs${workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ""}`),
  run: (id: string) => request<RunDetail>(`/runs/${id}`),
  tick: () => request<{ scheduled: number; resumed: number }>("/tick", { method: "POST" }),
};
