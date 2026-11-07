import { Hono } from "hono";
import { workflowInput } from "../shared/schema";
import {
  deleteWorkflow,
  type Env,
  getRunLogs,
  getRunRow,
  getWorkflow,
  getWorkflowByHook,
  insertWorkflow,
  listRuns,
  listWorkflows,
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

async function sameToken(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

// ---------- API (used by the dashboard) ----------

const api = new Hono<{ Bindings: Env }>();

api.get("/health", (c) => c.json({ ok: true }));
api.get("/config", (c) => c.json({ authRequired: Boolean(c.env.ADMIN_TOKEN) }));

api.use("*", async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token) return next();
  const given = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!given || !(await sameToken(given, token))) return c.json({ error: "Sign in with your access token" }, 401);
  return next();
});

api.get("/workflows", async (c) => c.json(await listWorkflows(c.env.DB)));

api.post("/workflows", async (c) => {
  const parsed = workflowInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Check the highlighted fields", issues: parsed.error.issues }, 400);
  return c.json(await insertWorkflow(c.env.DB, parsed.data, Date.now()), 201);
});

api.get("/workflows/:id", async (c) => {
  const wf = await getWorkflow(c.env.DB, c.req.param("id"));
  return wf ? c.json(wf) : c.json({ error: "No workflow with that id" }, 404);
});

api.put("/workflows/:id", async (c) => {
  const parsed = workflowInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Check the highlighted fields", issues: parsed.error.issues }, 400);
  const wf = await updateWorkflow(c.env.DB, c.req.param("id"), parsed.data, Date.now());
  return wf ? c.json(wf) : c.json({ error: "No workflow with that id" }, 404);
});

api.delete("/workflows/:id", async (c) => {
  const removed = await deleteWorkflow(c.env.DB, c.req.param("id"));
  return removed ? c.body(null, 204) : c.json({ error: "No workflow with that id" }, 404);
});

api.post("/workflows/:id/run", async (c) => {
  const wf = await getWorkflow(c.env.DB, c.req.param("id"));
  if (!wf) return c.json({ error: "No workflow with that id" }, 404);
  const body = await c.req.json().catch(() => ({}));
  // A manual run's input sits under `body`, like a webhook's, so `{{ trigger.body.x }}` works for both.
  const runId = await createRun(c.env, wf, "manual", { body: (body as { input?: unknown }).input ?? {} });
  c.executionCtx.waitUntil(advance(c.env, runId));
  return c.json({ runId }, 202);
});

api.get("/runs", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
  return c.json(await listRuns(c.env.DB, c.req.query("workflowId"), limit));
});

api.get("/runs/:id", async (c) => {
  const row = await getRunRow(c.env.DB, c.req.param("id"));
  if (!row) return c.json({ error: "No run with that id" }, 404);
  const logs = await getRunLogs(c.env.DB, row.id);
  return c.json({ ...toRun(row), logs, stepCount: JSON.parse(row.steps).length });
});

/** Runs the minute tick by hand. Handy in local development, where the cron doesn't fire on its own. */
api.post("/tick", async (c) => c.json(await tick(c.env)));

app.route("/api", api);

// ---------- Webhooks (public; the key in the URL is the secret) ----------

app.all("/hooks/:key", async (c) => {
  const wf = await getWorkflowByHook(c.env.DB, c.req.param("key"));
  if (!wf || wf.trigger.type !== "webhook") return c.json({ error: "Unknown webhook" }, 404);
  if (!wf.enabled) return c.json({ error: "This workflow is turned off" }, 409);

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
