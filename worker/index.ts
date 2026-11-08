import { Hono } from "hono";
import { LIMITS } from "../shared/limits";
import { workflowInput } from "../shared/schema";
import {
  countWorkflows,
  deleteWorkflow,
  type Env,
  getRunLogs,
  getRunRow,
  getWorkflow,
  getWorkflowByHook,
  insertWorkflow,
  listRuns,
  listWorkflows,
  recentRunCount,
  toRun,
  updateWorkflow,
} from "./db";
import { advance, createRun, tick } from "./engine";

const MAX_WEBHOOK_BYTES = 256 * 1024;

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong on our side" }, 500);
});

const WORKSPACE = /^ws_[A-Za-z0-9_-]{16,40}$/;

// ---------- API (used by the dashboard) ----------
//
// There are no accounts. The dashboard makes a random workspace id, keeps it in the browser and sends
// it with every request, and each workspace only ever sees its own workflows and runs.

const api = new Hono<{ Bindings: Env; Variables: { workspace: string } }>();

api.get("/health", (c) => c.json({ ok: true }));
api.get("/limits", (c) => c.json(LIMITS));

api.use("*", async (c, next) => {
  const workspace = c.req.header("x-knotwork-workspace") ?? "";
  if (!WORKSPACE.test(workspace)) return c.json({ error: "Missing or malformed workspace id" }, 400);
  c.set("workspace", workspace);
  return next();
});

const tooManyRuns = () => ({
  error: `This workspace has started ${LIMITS.runsPerWorkspacePerHour} runs in the last hour, which is the limit. Try again later.`,
});

api.get("/workflows", async (c) => c.json(await listWorkflows(c.env.DB, c.var.workspace)));

api.post("/workflows", async (c) => {
  const parsed = workflowInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Check the highlighted fields", issues: parsed.error.issues }, 400);
  if ((await countWorkflows(c.env.DB, c.var.workspace)) >= LIMITS.workflowsPerWorkspace) {
    return c.json({ error: `A workspace can hold ${LIMITS.workflowsPerWorkspace} workflows. Delete one to make room.` }, 409);
  }
  return c.json(await insertWorkflow(c.env.DB, c.var.workspace, parsed.data, Date.now()), 201);
});

api.get("/workflows/:id", async (c) => {
  const wf = await getWorkflow(c.env.DB, c.req.param("id"), c.var.workspace);
  return wf ? c.json(wf) : c.json({ error: "No workflow with that id" }, 404);
});

api.put("/workflows/:id", async (c) => {
  const parsed = workflowInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Check the highlighted fields", issues: parsed.error.issues }, 400);
  const wf = await updateWorkflow(c.env.DB, c.req.param("id"), c.var.workspace, parsed.data, Date.now());
  return wf ? c.json(wf) : c.json({ error: "No workflow with that id" }, 404);
});

api.delete("/workflows/:id", async (c) => {
  const removed = await deleteWorkflow(c.env.DB, c.req.param("id"), c.var.workspace);
  return removed ? c.body(null, 204) : c.json({ error: "No workflow with that id" }, 404);
});

api.post("/workflows/:id/run", async (c) => {
  const wf = await getWorkflow(c.env.DB, c.req.param("id"), c.var.workspace);
  if (!wf) return c.json({ error: "No workflow with that id" }, 404);
  if ((await recentRunCount(c.env.DB, c.var.workspace, Date.now())) >= LIMITS.runsPerWorkspacePerHour) {
    return c.json(tooManyRuns(), 429);
  }
  const body = await c.req.json().catch(() => ({}));
  // A manual run's input sits under `body`, like a webhook's, so `{{ trigger.body.x }}` works for both.
  const runId = await createRun(c.env, wf, "manual", { body: (body as { input?: unknown }).input ?? {} });
  c.executionCtx.waitUntil(advance(c.env, runId));
  return c.json({ runId }, 202);
});

api.get("/runs", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
  return c.json(await listRuns(c.env.DB, c.var.workspace, c.req.query("workflowId"), limit));
});

api.get("/runs/:id", async (c) => {
  const row = await getRunRow(c.env.DB, c.req.param("id"), c.var.workspace);
  if (!row) return c.json({ error: "No run with that id" }, 404);
  const logs = await getRunLogs(c.env.DB, row.id);
  return c.json({ ...toRun(row), logs, stepCount: JSON.parse(row.steps).length });
});

/** Runs the minute tick now. It only moves runs that are already due, so it's safe to expose. */
api.post("/tick", async (c) => c.json(await tick(c.env)));

app.route("/api", api);

// ---------- Webhooks (public; the key in the URL is the secret) ----------

app.all("/hooks/:key", async (c) => {
  const wf = await getWorkflowByHook(c.env.DB, c.req.param("key"));
  if (!wf || wf.trigger.type !== "webhook") return c.json({ error: "Unknown webhook" }, 404);
  if (!wf.enabled) return c.json({ error: "This workflow is turned off" }, 409);
  if ((await recentRunCount(c.env.DB, wf.workspaceId, Date.now())) >= LIMITS.runsPerWorkspacePerHour) {
    return c.json(tooManyRuns(), 429);
  }

  const text = await c.req.text();
  if (text.length > MAX_WEBHOOK_BYTES) return c.json({ error: "Payload is larger than 256 KB" }, 413);
  const type = c.req.header("content-type") ?? "";
  let body: unknown = text;
  if (type.includes("json") && text) {
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "The body isn't valid JSON" }, 400);
    }
  } else if (type.includes("application/x-www-form-urlencoded")) {
    body = Object.fromEntries(new URLSearchParams(text));
  }

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, name) => {
    if (name === "cookie" || name === "authorization" || name.startsWith("cf-") || name.startsWith("x-forwarded")) return;
    headers[name] = value;
  });

  const runId = await createRun(c.env, wf, "webhook", {
    method: c.req.method,
    query: c.req.query(),
    headers,
    body,
  });
  c.executionCtx.waitUntil(advance(c.env, runId));
  return c.json({ runId }, 202);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(tick(env));
  },
} satisfies ExportedHandler<Env>;
