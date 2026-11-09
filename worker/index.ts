import { type Context, Hono } from "hono";
import { LIMITS } from "../shared/limits";
import { loginInput, signupInput, workflowInput, workflowSave, workspaceInput, type Me } from "../shared/schema";
import {
  clearedCookie,
  counterValue,
  createSession,
  decoyPassword,
  findSession,
  hashPassword,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  sha256,
  underLimit,
  verifyPassword,
} from "./auth";
import {
  countWorkflows,
  deleteWorkflow,
  deleteWorkspace,
  getRun,
  getWorkflow,
  insertWorkflow,
  listRuns,
  listWorkflows,
  listWorkspaces,
  runBlocked,
  toWorkspace,
  updateWorkflow,
} from "./db";
import { DEMO_USER_ID, ensureDemo } from "./demo";
import { advance, createRun, tick } from "./engine";
import { type Env, Mongo, newUserId, newWorkspaceId, type SessionDoc, type UserDoc, type WorkspaceDoc } from "./mongo";

const MAX_WEBHOOK_BYTES = 256 * 1024;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Vars = { mongo: Mongo; later: Promise<unknown>[]; session: SessionDoc; workspace: string };
type C = Context<{ Bindings: Env; Variables: Vars }>;

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong on our side" }, 500);
});

// One database connection per request, opened on first use and closed once the response and any
// background work (a run started by this request) are done.
app.use("*", async (c, next) => {
  const mongo = new Mongo(c.env);
  const later: Promise<unknown>[] = [];
  c.set("mongo", mongo);
  c.set("later", later);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(Promise.allSettled(later).then(() => mongo.close()));
  }
});

const db = (c: C) => c.var.mongo.c;
const ip = (c: C) => c.req.header("cf-connecting-ip") ?? "local";
const secure = (c: C) => new URL(c.req.url).protocol === "https:";
const issues = (error: { issues: unknown[] }) => ({ error: "Check the highlighted fields", issues: error.issues });

// ---------- API (used by the dashboard) ----------

const api = new Hono<{ Bindings: Env; Variables: Vars }>();

// The session cookie is SameSite=Lax; on top of that, writes must come from this site.
api.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (origin && new URL(origin).host !== new URL(c.req.url).host) return c.json({ error: "Cross-site request refused" }, 403);
  }
  return next();
});

api.get("/health", (c) => c.json({ ok: true }));
api.get("/limits", (c) => c.json(LIMITS));

// ---------- Accounts ----------

async function me(c: C, userId: string): Promise<Me | null> {
  const [user, workspaces] = await Promise.all([db(c).users.findOne({ _id: userId }), listWorkspaces(db(c), userId)]);
  if (!user) return null;
  return { user: { id: user._id, name: user.name, email: user.email, demo: user.demo }, workspaces };
}

async function signIn(c: C, user: Pick<UserDoc, "_id" | "demo">) {
  const token = await createSession(db(c), user, Date.now());
  c.header("set-cookie", sessionCookie(token, secure(c)));
  return c.json(await me(c, user._id));
}

api.post("/auth/signup", async (c) => {
  const parsed = signupInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  const { name, email, password } = parsed.data;
  const now = Date.now();
  if (!(await underLimit(db(c), `signup:ip:${ip(c)}`, HOUR, LIMITS.signupsPerIpPerHour, now))) {
    return c.json({ error: "Too many new accounts from your network. Try again in an hour." }, 429);
  }
  if (!(await underLimit(db(c), "signup:all", 24 * HOUR, LIMITS.signupsPerDay, now))) {
    return c.json({ error: "Knotwork has had all the sign-ups it can take today. Try the demo account, or come back tomorrow." }, 429);
  }
  const user: UserDoc = { _id: newUserId(), name, email, password: await hashPassword(password), demo: false, createdAt: now };
  try {
    await db(c).users.insertOne(user);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      return c.json({ error: "There's already an account with that email. Log in instead.", issues: [{ path: ["email"], message: "Already registered" }] }, 409);
    }
    throw err;
  }
  const personal: WorkspaceDoc = { _id: newWorkspaceId(), ownerId: user._id, name: "Personal", personal: true, createdAt: now };
  await db(c).workspaces.insertOne(personal);
  return signIn(c, user);
});

api.post("/auth/login", async (c) => {
  const parsed = loginInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  const { email, password } = parsed.data;
  const key = `login:${ip(c)}:${await sha256(email)}`;
  if ((await counterValue(db(c), key, 15 * MINUTE)) >= LIMITS.failedLoginsPer15Min) {
    return c.json({ error: "Too many wrong passwords. Wait 15 minutes and try again." }, 429);
  }
  const user = await db(c).users.findOne({ email });
  // Check a decoy hash for unknown emails, so a wrong email and a wrong password take the same time.
  const ok = await verifyPassword(password, user?.password ?? (await decoyPassword()));
  if (!user || !user.password || !ok) {
    await underLimit(db(c), key, 15 * MINUTE, LIMITS.failedLoginsPer15Min);
    return c.json({ error: "That email and password don't match an account." }, 401);
  }
  return signIn(c, user);
});

api.post("/auth/demo", async (c) => {
  if (!(await underLimit(db(c), `demo:ip:${ip(c)}`, HOUR, 30))) {
    return c.json({ error: "Too many demo sign-ins from your network. Try again in an hour." }, 429);
  }
  await ensureDemo(db(c), Date.now());
  return signIn(c, { _id: DEMO_USER_ID, demo: true });
});

api.post("/auth/logout", async (c) => {
  const token = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  if (token) await db(c).sessions.deleteOne({ _id: await sha256(token) });
  c.header("set-cookie", clearedCookie(secure(c)));
  return c.body(null, 204);
});

// Everything below needs a signed-in user.
api.use("*", async (c, next) => {
  const session = await findSession(db(c), readCookie(c.req.header("cookie"), SESSION_COOKIE));
  if (!session) return c.json({ error: "Log in to continue" }, 401);
  c.set("session", session);
  return next();
});

api.get("/me", async (c) => {
  const data = await me(c, c.var.session.userId);
  return data ? c.json(data) : c.json({ error: "Log in to continue" }, 401);
});

// ---------- Workspaces ----------

api.get("/workspaces", async (c) => c.json(await listWorkspaces(db(c), c.var.session.userId)));

api.post("/workspaces", async (c) => {
  const parsed = workspaceInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  const ownerId = c.var.session.userId;
  if ((await db(c).workspaces.countDocuments({ ownerId })) >= LIMITS.workspacesPerAccount) {
    return c.json({ error: `An account can have ${LIMITS.workspacesPerAccount} workspaces. Delete one to make room.` }, 409);
  }
  const ws: WorkspaceDoc = { _id: newWorkspaceId(), ownerId, name: parsed.data.name, personal: false, createdAt: Date.now() };
  await db(c).workspaces.insertOne(ws);
  await db(c).sessions.updateMany({ userId: ownerId }, { $addToSet: { workspaceIds: ws._id } });
  return c.json(toWorkspace(ws), 201);
});

api.patch("/workspaces/:id", async (c) => {
  const parsed = workspaceInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  const ws = await db(c).workspaces.findOneAndUpdate(
    { _id: c.req.param("id"), ownerId: c.var.session.userId },
    { $set: { name: parsed.data.name } },
    { returnDocument: "after" },
  );
  return ws ? c.json(toWorkspace(ws)) : c.json({ error: "No workspace with that id" }, 404);
});

api.delete("/workspaces/:id", async (c) => {
  const removed = await deleteWorkspace(db(c), c.req.param("id"), c.var.session.userId);
  return removed ? c.body(null, 204) : c.json({ error: "No workspace with that id, or it's your personal one" }, 404);
});

// ---------- Workflows and runs (inside one workspace) ----------
//
// The dashboard says which workspace it is looking at with the x-knotwork-workspace header. The
// session lists the workspaces this user owns, so checking it needs no extra query.

const scoped = new Hono<{ Bindings: Env; Variables: Vars }>();

scoped.use("*", async (c, next) => {
  const workspace = c.req.header("x-knotwork-workspace") ?? "";
  if (!c.var.session.workspaceIds.includes(workspace)) return c.json({ error: "No workspace with that id" }, 404);
  c.set("workspace", workspace);
  return next();
});

scoped.get("/workflows", async (c) => c.json(await listWorkflows(db(c), c.var.workspace)));

/** Everything the sidebar and home page show, in one request: the app polls this while it's open. */
scoped.get("/overview", async (c) => {
  const [workflows, runs, runsThisHour] = await Promise.all([
    listWorkflows(db(c), c.var.workspace),
    listRuns(db(c), c.var.workspace, undefined, 200),
    db(c).runs.countDocuments({ ownerId: c.var.session.userId, createdAt: { $gt: Date.now() - HOUR } }),
  ]);
  return c.json({ workflows, runs, runsThisHour });
});

scoped.post("/workflows", async (c) => {
  const parsed = workflowInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  if ((await countWorkflows(db(c), c.var.workspace)) >= LIMITS.workflowsPerWorkspace) {
    return c.json({ error: `A workspace can hold ${LIMITS.workflowsPerWorkspace} workflows. Delete one to make room.` }, 409);
  }
  return c.json(await insertWorkflow(db(c), c.var.workspace, c.var.session.userId, parsed.data, Date.now()), 201);
});

scoped.get("/workflows/:id", async (c) => {
  const wf = await getWorkflow(db(c), c.req.param("id"), c.var.workspace);
  return wf ? c.json(wf) : c.json({ error: "No workflow with that id" }, 404);
});

scoped.put("/workflows/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = workflowInput.safeParse(body);
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  const version = workflowSave.safeParse(body);
  if (!version.success) return c.json({ error: "Missing the version this workflow was loaded at" }, 400);
  const res = await updateWorkflow(db(c), c.req.param("id"), c.var.workspace, parsed.data, version.data.version, Date.now());
  if (res.ok) return c.json(res.workflow);
  if (res.reason === "stale") {
    return c.json({ error: "This workflow was changed somewhere else since you opened it.", current: res.current }, 409);
  }
  return c.json({ error: "No workflow with that id" }, 404);
});

scoped.delete("/workflows/:id", async (c) => {
  const removed = await deleteWorkflow(db(c), c.req.param("id"), c.var.workspace);
  return removed ? c.body(null, 204) : c.json({ error: "No workflow with that id" }, 404);
});

scoped.post("/workflows/:id/run", async (c) => {
  const doc = await db(c).workflows.findOne({ _id: c.req.param("id"), workspaceId: c.var.workspace });
  if (!doc) return c.json({ error: "No workflow with that id" }, 404);
  const blocked = await runBlocked(db(c), doc.ownerId, Date.now());
  if (blocked) return c.json({ error: blocked }, 429);
  const body = await c.req.json().catch(() => ({}));
  // A manual run's input sits under `body`, like a webhook's, so `{{ trigger.body.x }}` works for both.
  const runId = await createRun(db(c), { ...doc, id: doc._id }, "manual", { body: (body as { input?: unknown }).input ?? {} });
  c.var.later.push(advance(db(c), runId));
  return c.json({ runId }, 202);
});

scoped.get("/runs", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
  return c.json(await listRuns(db(c), c.var.workspace, c.req.query("workflowId"), limit));
});

scoped.get("/runs/:id", async (c) => {
  const run = await getRun(db(c), c.req.param("id"), c.var.workspace);
  return run ? c.json(run) : c.json({ error: "No run with that id" }, 404);
});

/** "Check now" on a waiting run: moves only this run, and only if it's due. */
scoped.post("/runs/:id/check", async (c) => {
  const run = await db(c).runs.findOne({ _id: c.req.param("id"), workspaceId: c.var.workspace }, { projection: { _id: 1 } });
  if (!run) return c.json({ error: "No run with that id" }, 404);
  await advance(db(c), run._id);
  return c.json(await getRun(db(c), run._id, c.var.workspace));
});

api.route("/", scoped);
app.route("/api", api);

// ---------- Webhooks (public; the key in the URL is the secret) ----------

app.all("/hooks/:key", async (c) => {
  const doc = await db(c).workflows.findOne({ hookKey: c.req.param("key") });
  if (!doc || doc.trigger.type !== "webhook") return c.json({ error: "Unknown webhook" }, 404);
  if (!doc.enabled) return c.json({ error: "This workflow is turned off" }, 409);
  const blocked = await runBlocked(db(c), doc.ownerId, Date.now());
  if (blocked) return c.json({ error: blocked }, 429);

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

  const runId = await createRun(db(c), { ...doc, id: doc._id }, "webhook", { method: c.req.method, query: c.req.query(), headers, body });
  c.var.later.push(advance(db(c), runId));
  return c.json({ runId }, 202);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    const mongo = new Mongo(env);
    ctx.waitUntil(tick(mongo.c).finally(() => mongo.close()));
  },
} satisfies ExportedHandler<Env>;
