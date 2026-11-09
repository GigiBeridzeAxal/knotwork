import type { Me, Overview, Run, RunDetail, Workflow, WorkflowInput, WorkflowSummary, Workspace } from "../shared/schema";

/**
 * The signed-in session lives in an HttpOnly cookie the browser sends by itself. The workspace being
 * looked at is sent as a header; the server checks the user owns it.
 */
let currentWorkspace = "";
export const setCurrentWorkspace = (id: string) => {
  currentWorkspace = id;
};

/** Called when any request comes back 401, so the app can send the user to the login page. */
let onSignedOut = () => {};
export const whenSignedOut = (fn: () => void) => {
  onSignedOut = fn;
};

export interface Issue {
  path: (string | number)[];
  message: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public issues: Issue[] = [],
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (currentWorkspace) headers.set("x-knotwork-workspace", currentWorkspace);
  const res = await fetch(`/api${path}`, { ...init, headers, credentials: "same-origin" });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/auth/")) onSignedOut();
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.issues, data);
  return data as T;
}

const post = (body?: unknown): RequestInit => ({ method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  me: () => request<Me>("/me"),
  signup: (input: { name: string; email: string; password: string }) => request<Me>("/auth/signup", post(input)),
  login: (input: { email: string; password: string }) => request<Me>("/auth/login", post(input)),
  demo: () => request<Me>("/auth/demo", post()),
  logout: () => request<void>("/auth/logout", post()),

  createWorkspace: (name: string) => request<Workspace>("/workspaces", post({ name })),
  renameWorkspace: (id: string, name: string) =>
    request<Workspace>(`/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteWorkspace: (id: string) => request<void>(`/workspaces/${id}`, { method: "DELETE" }),

  overview: () => request<Overview>("/overview"),
  workflows: () => request<WorkflowSummary[]>("/workflows"),
  workflow: (id: string) => request<Workflow>(`/workflows/${id}`),
  createWorkflow: (input: WorkflowInput) => request<Workflow>("/workflows", post(input)),
  updateWorkflow: (id: string, input: WorkflowInput, version: number) =>
    request<Workflow>(`/workflows/${id}`, { method: "PUT", body: JSON.stringify({ ...input, version }) }),
  deleteWorkflow: (id: string) => request<void>(`/workflows/${id}`, { method: "DELETE" }),
  runWorkflow: (id: string, input: unknown) => request<{ runId: string }>(`/workflows/${id}/run`, post({ input })),
  runs: (workflowId?: string, limit?: number) => {
    const q = new URLSearchParams();
    if (workflowId) q.set("workflowId", workflowId);
    if (limit) q.set("limit", String(limit));
    const qs = q.toString();
    return request<Run[]>(`/runs${qs ? `?${qs}` : ""}`);
  },
  run: (id: string) => request<RunDetail>(`/runs/${id}`),
  checkRun: (id: string) => request<RunDetail>(`/runs/${id}/check`, post()),
};
