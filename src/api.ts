import type { Run, RunDetail, Workflow, WorkflowInput, WorkflowSummary } from "../shared/schema";

const TOKEN_KEY = "knotwork.token";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the token lasts for this page only.
  }
  memoryToken = token;
}

let memoryToken = "";
const listeners = new Set<() => void>();
export const onUnauthorized = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
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
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken() || memoryToken;
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (res.status === 401) listeners.forEach((fn) => fn());
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.issues);
  return data as T;
}

export const api = {
  config: () => request<{ authRequired: boolean }>("/config"),
  checkToken: () => request<WorkflowSummary[]>("/workflows"),
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
