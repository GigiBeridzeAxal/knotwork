import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { LIMITS } from "../shared/limits";
import {
  accountDelete,
  loginInput,
  type Me,
  passwordChange,
  secretInput,
  secretName,
  signupInput,
  workflowInput,
  workflowSave,
  workspaceInput,
} from "../shared/schema";
import {
  clearedCookie,
  cookieName,
  counterValue,
  createSession,
  DECOY_PASSWORD,
  findSession,
  giveBack,
  hashPassword,
  hookKeyValid,
  ipKey,
  newHookKey,
  readCookie,
  sessionCookie,
  sha256,
  underLimit,
  verifyPassword,
} from "./auth";
import {
  deleteWorkflow,
  deleteWorkspace,
  getRun,
  getWorkflow,
  insertWorkflow,
  listRuns,
  listWorkflows,
  listWorkspaces,
  runBytes,
  runCounter,
  runLimit,
  storageFull,
  takeRunSlot,
  toWorkspace,
  updateWorkflow,
} from "./db";
import { DEMO_USER_ID, ensureDemo } from "./demo";
import { advance, createRun, tick } from "./engine";
import { deleteSecret, listSecrets, loadSecrets, putSecret } from "./secrets";
import { signatureProblem } from "./signature";
import { type Env, Mongo, newUserId, newWorkspaceId, type SessionDoc, type UserDoc, type WorkspaceDoc } from "./mongo";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Biggest request body the API accepts. A workflow is at most LIMITS.workflowBytes of JSON. */
const MAX_API_BODY = 64 * 1024;
/** How much of a webhook call's headers and query string a run keeps (characters). */
const MAX_HOOK_HEADER_CHARS = 8_000;
const MAX_HOOK_QUERY_CHARS = 2_000;

type Vars = { mongo: Mongo; later: Promise<unknown>[]; session: SessionDoc; workspace: string };
type C = Context<{ Bindings: Env; Variables: Vars }>;

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong on our side" }, 500);
});

const ip = (c: C) => ipKey(c.req.header("cf-connecting-ip") ?? "local");
/** The network key for sign-up limits: IPv6 grouped by /48 instead of /64. */
const network = (c: C) => ipKey(c.req.header("cf-connecting-ip") ?? "local", 48);
/** The host of an Origin header, or "" for one that isn't a URL (e.g. "null" from a sandboxed page). */
const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
};
const secure = (c: C) => new URL(c.req.url).protocol === "https:";
const issues = (error: { issues: unknown[] }) => ({ error: "Check the highlighted fields", issues: error.issues });
const tooLarge = (c: C) => c.json({ error: `The request is larger than ${MAX_API_BODY / 1024} KB` }, 413);

// A per-IP request budget, checked by Cloudflare before any database work. Skipped for loopback
// addresses, which only local development sends (every test browser there shares one address).
const LOOPBACK = new Set(["127.0.0.1", "::1", "local"]);
// Webhooks are limited per hook key instead (below): senders such as GitHub, Stripe or another
// Worker deliver for many customers from a few shared addresses, so a per-IP limit would let one
// noisy sender block everyone else's webhooks.
app.use("*", async (c, next) => {
  const from = c.req.header("cf-connecting-ip") ?? "local";
  if (!LOOPBACK.has(from) && !c.req.path.startsWith("/hooks/")) {
    // Per address (IPv6 per /64), and per network (IPv6 per /48, which anyone can get for free and
    // which holds 65,536 /64s).
    const [address, network] = await Promise.all([
      c.env.IP_LIMITER?.limit({ key: ipKey(from) }),
      c.env.NET_LIMITER?.limit({ key: `api:${ipKey(from, 48)}` }),
    ]);
    if (address?.success === false || network?.success === false) {
      return c.json({ error: "Too many requests from your network. Wait a minute and try again." }, 429);
    }
  }
  return next();
});

// The hub's long-lived database connection, or (without the hub) one per request, opened on first
// use and closed once the response and any background work (a run started by this request) are done.
app.use("*", async (c, next) => {
  const shared = c.env.SHARED_MONGO;
  const mongo = shared ?? new Mongo(c.env);
  const later: Promise<unknown>[] = [];
  c.set("mongo", mongo);
  c.set("later", later);
  const start = Date.now();
  try {
    await next();
    // How long the database connection took to open, and the whole request, so slow pages can be
    // told apart from slow handshakes (browser dev tools show this under Timing).
    const timing = [`total;dur=${Date.now() - start}`];
    if (mongo.connected >= start) timing.unshift(`db-connect;dur=${mongo.connected - mongo.started}`);
    c.res.headers.append("Server-Timing", timing.join(", "));
  } finally {
    c.executionCtx.waitUntil(Promise.allSettled(later).then(() => (shared ? undefined : mongo.close())));
  }
});

const db = (c: C) => c.var.mongo.c;

/** The one hub, placed in western Europe next to the Atlas cluster (Frankfurt). */
const hub = (env: Env) => env.HUB!.get(env.HUB!.idFromName("main"), { locationHint: "weur" });
/** The hub's cron entry. The Worker only forwards /api/ and /hooks/ paths, so visitors can't reach it. */
export const HUB_TICK = "https://hub.internal/__hub/tick";

// ---------- API (used by the dashboard) ----------

const api = new Hono<{ Bindings: Env; Variables: Vars }>();

api.use("*", bodyLimit({ maxSize: MAX_API_BODY, onError: tooLarge }));

// The session cookie is SameSite=Lax; on top of that, writes must come from this site.
api.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (origin && hostOf(origin) !== new URL(c.req.url).host) return c.json({ error: "Cross-site request refused" }, 403);
  }
  return next();
});

api.get("/health", (c) => c.json({ ok: true }));
api.get("/limits", (c) => c.json(LIMITS));

// ---------- Accounts ----------

async function me(c: C, userId: string): Promise<Me | null> {
  const [user, found] = await Promise.all([db(c).users.findOne({ _id: userId }), listWorkspaces(db(c), userId)]);
  if (!user) return null;
  let workspaces = found;
  if (!workspaces.some((w) => w.personal)) {
    // Every account keeps a Personal workspace. If a sign-up was cut off before it was made, make it now
    // (a fixed id, so two requests at once still make one).
    const id = `ws_p_${user._id.slice(4)}`;
    await db(c).workspaces.updateOne(
      { _id: id },
      { $setOnInsert: { ownerId: user._id, name: "Personal", personal: true, createdAt: Date.now() } },
      { upsert: true },
    );
    await db(c).sessions.updateMany({ userId: user._id }, { $addToSet: { workspaceIds: id } });
    workspaces = await listWorkspaces(db(c), userId);
  }
  return { user: { id: user._id, name: user.name, email: user.email, demo: user.demo }, workspaces };
}

async function signIn(c: C, user: Pick<UserDoc, "_id" | "demo">) {
  const { token, maxAge } = await createSession(db(c), user, Date.now());
  c.header("set-cookie", sessionCookie(token, secure(c), maxAge));
  return c.json(await me(c, user._id));
}

const loginKey = async (c: C, email: string) => `login:${ip(c)}:${await sha256(email)}`;
const WRONG_PASSWORDS = "Too many wrong passwords. Wait 15 minutes and try again.";

api.post("/auth/signup", async (c) => {
  const parsed = signupInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  const { name, email, password } = parsed.data;
  const now = Date.now();
  const ipCounter = `signup:ip:${network(c)}`;
  if (!(await underLimit(db(c), ipCounter, HOUR, LIMITS.signupsPerIpPerHour, now))) {
    return c.json({ error: "Too many new accounts from your network. Try again in an hour." }, 429);
  }
  // Only accounts that were really created count toward the daily total (added below), so failed
  // attempts can't use it up for everyone.
  const [today, full] = await Promise.all([counterValue(db(c), "signup:all", 24 * HOUR, now), storageFull(db(c))]);
  if (today >= LIMITS.signupsPerDay || full) {
    return c.json({ error: "Knotwork has had all the sign-ups it can take today. Try the demo account, or come back tomorrow." }, 429);
  }
  const user: UserDoc = {
    _id: newUserId(),
    name,
    email,
    password: await hashPassword(password, c.env.AUTH_PEPPER),
    demo: false,
    createdAt: now,
  };
  try {
    await db(c).users.insertOne(user);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      // No account was made, so this attempt doesn't count toward the network's hourly sign-ups. It
      // counts toward its own limit instead, so the form can't be used to test which emails exist.
      const [, ok] = await Promise.all([
        giveBack(db(c), ipCounter, HOUR, now),
        underLimit(db(c), `signup:dup:${network(c)}`, HOUR, LIMITS.duplicateSignupsPerHour, now),
      ]);
      if (!ok) return c.json({ error: "Too many new accounts from your network. Try again in an hour." }, 429);
      return c.json({ error: "There's already an account with that email. Log in instead.", issues: [{ path: ["email"], message: "Already registered" }] }, 409);
    }
    throw err;
  }
  const personal: WorkspaceDoc = { _id: newWorkspaceId(), ownerId: user._id, name: "Personal", personal: true, createdAt: now };
  await Promise.all([db(c).workspaces.insertOne(personal), underLimit(db(c), "signup:all", 24 * HOUR, Number.MAX_SAFE_INTEGER, now)]);
  return signIn(c, user);
});

api.post("/auth/login", async (c) => {
  const parsed = loginInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  const { email, password } = parsed.data;
  // Every attempt takes a slot first, so parallel guesses can't all get through; a right password
  // gives its slot back.
  const key = await loginKey(c, email);
  if (!(await underLimit(db(c), key, 15 * MINUTE, LIMITS.loginAttemptsPer15Min))) return c.json({ error: WRONG_PASSWORDS }, 429);
  const user = await db(c).users.findOne({ email });
  // Check a decoy hash for unknown emails, so a wrong email and a wrong password take the same time.
  const ok = await verifyPassword(password, user?.password ?? DECOY_PASSWORD, c.env.AUTH_PEPPER);
  if (!user || !user.password || !ok) return c.json({ error: "That email and password don't match an account." }, 401);
  await giveBack(db(c), key, 15 * MINUTE);
  return signIn(c, user);
});

api.post("/auth/demo", async (c) => {
  if (!(await underLimit(db(c), `demo:ip:${network(c)}`, HOUR, LIMITS.demoLoginsPerIpPerHour))) {
    return c.json({ error: "Too many demo sign-ins from your network. Try again in an hour." }, 429);
  }
  await ensureDemo(db(c), Date.now(), c.env.AUTH_PEPPER);
  return signIn(c, { _id: DEMO_USER_ID, demo: true });
});

api.post("/auth/logout", async (c) => {
  const token = readCookie(c.req.header("cookie"), cookieName(secure(c)));
  if (token) await db(c).sessions.deleteOne({ _id: await sha256(token) });
  c.header("set-cookie", clearedCookie(secure(c)));
  return c.body(null, 204);
});

// Everything below needs a signed-in user.
api.use("*", async (c, next) => {
  const session = await findSession(db(c), readCookie(c.req.header("cookie"), cookieName(secure(c))));
  if (!session) return c.json({ error: "Log in to continue" }, 401);
  c.set("session", session);
  return next();
});

api.get("/me", async (c) => {
  const data = await me(c, c.var.session.userId);
  return data ? c.json(data) : c.json({ error: "Log in to continue" }, 401);
});

/** Checks the signed-in user's password for a sensitive change, under the same limit as logging in. */
async function confirmPassword(c: C, password: string): Promise<Response | UserDoc> {
  if (c.var.session.demo) return c.json({ error: "The demo account is shared, so its settings can't be changed." }, 403);
  const user = await db(c).users.findOne({ _id: c.var.session.userId });
  if (!user) return c.json({ error: "Log in to continue" }, 401);
  const key = await loginKey(c, user.email);
  if (!(await underLimit(db(c), key, 15 * MINUTE, LIMITS.loginAttemptsPer15Min))) return c.json({ error: WRONG_PASSWORDS }, 429);
  if (!(await verifyPassword(password, user.password, c.env.AUTH_PEPPER))) {
    return c.json({ error: "That isn't your current password.", issues: [{ path: ["current"], message: "Wrong password" }] }, 403);
  }
  await giveBack(db(c), key, 15 * MINUTE);
  return user;
}

/** Changes the password and signs out every other device. */
api.post("/auth/password", async (c) => {
  const parsed = passwordChange.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  const user = await confirmPassword(c, parsed.data.current);
  if (user instanceof Response) return user;
  await db(c).users.updateOne({ _id: user._id }, { $set: { password: await hashPassword(parsed.data.next, c.env.AUTH_PEPPER) } });
  await db(c).sessions.deleteMany({ userId: user._id, _id: { $ne: c.var.session._id } });
  return c.body(null, 204);
});

/** Deletes the account with everything in it: workspaces, workflows, runs and sessions. */
api.post("/auth/delete-account", async (c) => {
  const parsed = accountDelete.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  const user = await confirmPassword(c, parsed.data.password);
  if (user instanceof Response) return user;
  const ownerId = user._id;
  // The account and its sign-ins go first, so it is gone even if the request is cut off part way.
  // Then the workflows (which stops their webhooks and schedules), then everything else.
  await db(c).users.deleteOne({ _id: ownerId });
  await db(c).sessions.deleteMany({ userId: ownerId });
  await db(c).workflows.deleteMany({ ownerId });
  await db(c).runs.deleteMany({ ownerId });
  await db(c).secrets.deleteMany({ ownerId });
  await db(c).workspaces.deleteMany({ ownerId });
  c.header("set-cookie", clearedCookie(secure(c)));
  return c.body(null, 204);
});

// ---------- Workspaces ----------

api.get("/workspaces", async (c) => c.json(await listWorkspaces(db(c), c.var.session.userId)));

api.post("/workspaces", async (c) => {
  const parsed = workspaceInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  const ownerId = c.var.session.userId;
  const ws: WorkspaceDoc = { _id: newWorkspaceId(), ownerId, name: parsed.data.name, personal: false, createdAt: Date.now() };
  // Insert, then count: two requests at once can't both squeeze under the limit.
  await db(c).workspaces.insertOne(ws);
  if ((await db(c).workspaces.countDocuments({ ownerId })) > LIMITS.workspacesPerAccount) {
    await db(c).workspaces.deleteOne({ _id: ws._id });
    return c.json({ error: `An account can have ${LIMITS.workspacesPerAccount} workspaces. Delete one to make room.` }, 409);
  }
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

/**
 * Which of the user's workspaces a workflow or run is in, so a link opened while another workspace is
 * selected can switch to the right one instead of saying it doesn't exist.
 */
api.get("/locate/:kind/:id", async (c) => {
  const { kind, id } = c.req.param();
  const filter = { _id: id, workspaceId: { $in: c.var.session.workspaceIds } };
  const options = { projection: { workspaceId: 1 } };
  const doc =
    kind === "workflow" ? await db(c).workflows.findOne(filter, options) : kind === "run" ? await db(c).runs.findOne(filter, options) : null;
  return doc ? c.json({ workspaceId: doc.workspaceId }) : c.json({ error: "Not found in any of your workspaces" }, 404);
});

// ---------- Workflows and runs (inside one workspace) ----------
//
// The dashboard says which workspace it is looking at with the x-knotwork-workspace header. The
// session lists the workspaces this user owns, so checking it usually needs no extra query.

const scoped = new Hono<{ Bindings: Env; Variables: Vars }>();

scoped.use("*", async (c, next) => {
  const workspace = c.req.header("x-knotwork-workspace") ?? "";
  if (!c.var.session.workspaceIds.includes(workspace)) {
    // A workspace made after this session started (e.g. on another device) isn't in its list yet.
    const owned = workspace && (await db(c).workspaces.findOne({ _id: workspace, ownerId: c.var.session.userId }, { projection: { _id: 1 } }));
    if (!owned) return c.json({ error: "No workspace with that id" }, 404);
    await db(c).sessions.updateOne({ _id: c.var.session._id }, { $addToSet: { workspaceIds: workspace } });
  }
  c.set("workspace", workspace);
  return next();
});

scoped.get("/workflows", async (c) => c.json(await listWorkflows(db(c), c.var.workspace)));

/** Everything the sidebar and home page show, in one request: the app polls this while it's open. */
scoped.get("/overview", async (c) => {
  const now = Date.now();
  const [workflows, runs, runsThisHour, runsLimit] = await Promise.all([
    listWorkflows(db(c), c.var.workspace),
    listRuns(db(c), c.var.workspace, undefined, 100),
    counterValue(db(c), runCounter(c.var.session.userId), HOUR, now),
    runLimit(db(c), c.var.session.userId, now),
  ]);
  return c.json({ workflows, runs, runsThisHour, runsLimit: runsLimit ?? 0 });
});

scoped.post("/workflows", async (c) => {
  const parsed = workflowInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  const res = await insertWorkflow(db(c), c.var.workspace, c.var.session.userId, parsed.data, Date.now(), await newHookKey(c.env.AUTH_PEPPER));
  if (res === "full") return c.json({ error: `A workspace can hold ${LIMITS.workflowsPerWorkspace} workflows. Delete one to make room.` }, 409);
  if (res === "gone") return c.json({ error: "No workspace with that id" }, 404);
  return c.json(res, 201);
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
  const text = await c.req.text();
  if (text.length > LIMITS.runInputBytes) return c.json({ error: `Test input can be at most ${LIMITS.runInputBytes / 1000} KB` }, 413);
  let body: { input?: unknown } = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    return c.json({ error: "The test input isn't valid JSON" }, 400);
  }
  const doc = await db(c).workflows.findOne({ _id: c.req.param("id"), workspaceId: c.var.workspace });
  if (!doc) return c.json({ error: "No workflow with that id" }, 404);
  const blocked = await takeRunSlot(db(c), doc.ownerId, Date.now(), "manual", runBytes(body?.input, doc.steps));
  if (blocked) return c.json({ error: blocked }, 429);
  // A manual run's input sits under `body`, like a webhook's, so `{{ trigger.body.x }}` works for both.
  const runId = await createRun(db(c), { ...doc, id: doc._id }, "manual", { body: body?.input ?? {} });
  c.var.later.push(advance(db(c), runId, c.env.AUTH_PEPPER));
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
  await advance(db(c), run._id, c.env.AUTH_PEPPER);
  return c.json(await getRun(db(c), run._id, c.var.workspace));
});

/**
 * "Run again": starts a new run of the same workflow with the past run's input. It runs the workflow
 * as it is now (so a fixed workflow can be tried on the input that broke it) and counts as a manual run.
 */
scoped.post("/runs/:id/rerun", async (c) => {
  const past = await db(c).runs.findOne(
    { _id: c.req.param("id"), workspaceId: c.var.workspace },
    { projection: { workflowId: 1, status: 1, triggerType: 1, input: 1 } },
  );
  if (!past) return c.json({ error: "No run with that id" }, 404);
  if (past.status !== "succeeded" && past.status !== "failed" && past.status !== "stopped") {
    return c.json({ error: "This run hasn't finished yet. It can be run again once it has." }, 409);
  }
  // The storage guard empties the runs it stops; without the input there is nothing to repeat.
  if (past.input === null) return c.json({ error: "This run's input was removed to free space, so it can't be run again." }, 409);
  const doc = await db(c).workflows.findOne({ _id: past.workflowId, workspaceId: c.var.workspace });
  if (!doc) return c.json({ error: "This run's workflow has been deleted" }, 404);
  const blocked = await takeRunSlot(db(c), doc.ownerId, Date.now(), "manual", runBytes(past.input, doc.steps));
  if (blocked) return c.json({ error: blocked }, 429);
  const runId = await createRun(db(c), { ...doc, id: doc._id }, past.triggerType, past.input, past._id);
  c.var.later.push(advance(db(c), runId, c.env.AUTH_PEPPER));
  return c.json({ runId }, 202);
});

// ---------- Secrets (inside one workspace) ----------
//
// Names and dates only: a secret's value is never sent back, to anyone.

scoped.get("/secrets", async (c) => c.json(await listSecrets(db(c), c.var.workspace)));

const SHARED_DEMO_SECRETS = "The demo account is shared with everyone who opens it, so it can't keep secrets. Create a free account to use them.";

scoped.put("/secrets/:name", async (c) => {
  if (c.var.session.demo) return c.json({ error: SHARED_DEMO_SECRETS }, 403);
  const name = secretName.safeParse(c.req.param("name"));
  if (!name.success) return c.json({ error: "Check the highlighted fields", issues: [{ path: ["name"], message: name.error.issues[0].message }] }, 400);
  const parsed = secretInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  const res = await putSecret(db(c), c.env.AUTH_PEPPER, c.var.workspace, c.var.session.userId, name.data, parsed.data.value, Date.now());
  if (res === "full") return c.json({ error: `A workspace can keep ${LIMITS.secretsPerWorkspace} secrets. Delete one to make room.` }, 409);
  if (res === "gone") return c.json({ error: "No workspace with that id" }, 404);
  return c.json(res);
});

scoped.delete("/secrets/:name", async (c) => {
  if (c.var.session.demo) return c.json({ error: SHARED_DEMO_SECRETS }, 403);
  const removed = await deleteSecret(db(c), c.var.workspace, c.req.param("name"));
  return removed ? c.body(null, 204) : c.json({ error: "No secret with that name" }, 404);
});

api.route("/", scoped);
app.route("/api", api);

// ---------- Webhooks (public; the key in the URL is the secret) ----------

app.all(
  "/hooks/:key",
  bodyLimit({ maxSize: LIMITS.runInputBytes, onError: (c) => c.json({ error: `Payload is larger than ${LIMITS.runInputBytes / 1000} KB` }, 413) }),
  async (c) => {
    const key = c.req.param("key");
    // The key's own signature is checked first, with CPU only: a made-up key costs no database lookup.
    if (!(await hookKeyValid(key, c.env.AUTH_PEPPER))) return c.json({ error: "Unknown webhook" }, 404);
    // Per webhook URL, and a much looser per-IP limit (shared by every sender behind that address),
    // so made-up keys can't be used to make unlimited database lookups from one address.
    const from = c.req.header("cf-connecting-ip") ?? "local";
    const remote = !LOOPBACK.has(from);
    const [perHook, perIp, perNet] = await Promise.all([
      c.env.IP_LIMITER?.limit({ key: `hook:${key}` }),
      remote ? c.env.HOOK_IP_LIMITER?.limit({ key: ipKey(from) }) : undefined,
      remote ? c.env.HOOK_NET_LIMITER?.limit({ key: ipKey(from, 48) }) : undefined,
    ]);
    if (perHook?.success === false) return c.json({ error: "Too many calls to this webhook. Wait a minute and try again." }, 429);
    if (perIp?.success === false || perNet?.success === false) {
      return c.json({ error: "Too many webhook calls from your network. Wait a minute and try again." }, 429);
    }
    const doc = await db(c).workflows.findOne({ hookKey: key });
    if (!doc || doc.trigger.type !== "webhook") return c.json({ error: "Unknown webhook" }, 404);
    if (!doc.enabled) return c.json({ error: "This workflow is turned off" }, 409);

    // The bytes as they were sent: a signature covers exactly those.
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (raw.byteLength > LIMITS.runInputBytes) return c.json({ error: `Payload is larger than ${LIMITS.runInputBytes / 1000} KB` }, 413);
    const verify = doc.trigger.verify;
    if (verify) {
      // Refused calls start no run and use none of the account's run budget.
      const secret = (await loadSecrets(db(c), c.env.AUTH_PEPPER, doc.workspaceId, [verify.secret]))[verify.secret];
      // (The secret's name stays out of the answer: whoever holds the URL needn't learn it.)
      if (!secret) return c.json({ error: "Signature check failed: this webhook's signing secret isn't set in its workspace" }, 401);
      const problem = await signatureProblem(verify.provider, secret, c.req.raw.headers, raw);
      if (problem) return c.json({ error: `Signature check failed: ${problem}` }, 401);
    }
    const text = new TextDecoder().decode(raw);
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

    // Headers and query are kept for templates, up to a few KB each; the whole input counts toward the
    // run's byte budget.
    const headers: Record<string, string> = {};
    let headerBytes = 0;
    c.req.raw.headers.forEach((value, name) => {
      if (name === "cookie" || name === "authorization" || name.startsWith("cf-") || name.startsWith("x-forwarded")) return;
      headerBytes += name.length + value.length;
      if (headerBytes <= MAX_HOOK_HEADER_CHARS) headers[name] = value;
    });
    const query: Record<string, string> = {};
    let queryBytes = 0;
    for (const [name, value] of Object.entries(c.req.query())) {
      queryBytes += name.length + value.length;
      if (queryBytes <= MAX_HOOK_QUERY_CHARS) query[name] = value;
    }
    const input = { method: c.req.method, query, headers, body };

    const blocked = await takeRunSlot(db(c), doc.ownerId, Date.now(), "webhook", runBytes(input, doc.steps));
    if (blocked) return c.json({ error: blocked }, 429);

    const runId = await createRun(db(c), { ...doc, id: doc._id }, "webhook", input);
    c.var.later.push(advance(db(c), runId, c.env.AUTH_PEPPER));
    return c.json({ runId }, 202);
  },
);

/** The API and webhooks, run with the given environment (the hub passes its open connection in it). */
export const handle = app.fetch;

export { Hub } from "./hub";

export default {
  async fetch(request, env, ctx) {
    // The API and webhooks run in the hub, on its open database connection. (Static files never
    // reach this code; see run_worker_first in wrangler.jsonc.)
    const { pathname } = new URL(request.url);
    if (env.HUB && (pathname.startsWith("/api/") || pathname.startsWith("/hooks/"))) return hub(env).fetch(request);
    return app.fetch(request, env, ctx);
  },
  async scheduled(_controller, env, ctx) {
    if (env.HUB) {
      ctx.waitUntil(hub(env).fetch(HUB_TICK, { method: "POST" }).then((res) => res.body?.cancel()));
      return;
    }
    const mongo = new Mongo(env);
    ctx.waitUntil(tick(mongo.c, Date.now(), mongo.db, env.AUTH_PEPPER).finally(() => mongo.close()));
  },
} satisfies ExportedHandler<Env>;
