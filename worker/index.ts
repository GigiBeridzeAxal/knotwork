import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { LIMITS } from "../shared/limits";
import {
  accountDelete,
  apiKeyInput,
  canEdit,
  inviteInput,
  inviteToken,
  loginInput,
  type Me,
  passwordChange,
  recoverInput,
  recoveryCodesInput,
  type Role,
  roleChange,
  signupInput,
  type Workflow,
  workflowInput,
  workflowSave,
  type WorkflowSummary,
  workspaceInput,
} from "../shared/schema";
import {
  acceptInvite,
  accessTo,
  createApiKey,
  createInvite,
  deleteAccountAccess,
  findInvite,
  joinedWorkspaceIds,
  listApiKeys,
  listWorkspacesFor,
  removeMember,
  team,
  touchApiKey,
} from "./access";
import {
  apiKeyValid,
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
  newRecoveryCodes,
  readCookie,
  recoveryCodeHash,
  sessionCookie,
  sha256,
  sha256url,
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
import { type ApiKeyDoc, type Env, memberId, Mongo, newUserId, newWorkspaceId, type SessionDoc, type UserDoc, type WorkspaceDoc } from "./mongo";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Biggest request body the API accepts. A workflow is at most LIMITS.workflowBytes of JSON. */
const MAX_API_BODY = 64 * 1024;
/** How much of a webhook call's headers and query string a run keeps (characters). */
const MAX_HOOK_HEADER_CHARS = 8_000;
const MAX_HOOK_QUERY_CHARS = 2_000;

type Vars = {
  mongo: Mongo;
  later: Promise<unknown>[];
  /** Who is asking. For a request made with an API key, a stand-in for the key's maker. */
  session: SessionDoc;
  /** Set when the request was made with an API key instead of a signed-in browser. */
  key?: ApiKeyDoc;
  workspace: string;
  /** The asker's role in `workspace`, and whether this request may change things there. */
  role: Role;
  canWrite: boolean;
  /** The workspace's owner: the account its workflows, runs and limits belong to. */
  ownerId: string;
};
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
  const [user, found] = await Promise.all([db(c).users.findOne({ _id: userId }), listWorkspacesFor(db(c), userId)]);
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
    workspaces = await listWorkspacesFor(db(c), userId);
  }
  return {
    user: { id: user._id, name: user.name, email: user.email, demo: user.demo },
    workspaces,
    recoveryCodesLeft: user.recoveryCodes?.length ?? 0,
  };
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

/**
 * Sets a new password with a recovery code, for someone who lost theirs. Knotwork sends no email, so
 * the codes (made in Settings) are the only way back in. A code works once: the same update that
 * sets the password takes the code out, so two requests with one code can't both succeed. Every
 * device is signed out, and the answer is the same for an unknown email as for a wrong code.
 */
api.post("/auth/recover", async (c) => {
  const parsed = recoverInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  const { email, code, password } = parsed.data;
  // The same budget as wrong passwords, counted apart from them: ten tries per email and address in
  // 15 minutes. A code has 60 random bits, so guessing one is out of reach long before that matters.
  const key = `recover:${ip(c)}:${await sha256(email)}`;
  if (!(await underLimit(db(c), key, 15 * MINUTE, LIMITS.loginAttemptsPer15Min))) {
    return c.json({ error: "Too many wrong recovery codes. Wait 15 minutes and try again." }, 429);
  }
  const user = await db(c).users.findOne({ email });
  // The same work for an unknown email as for a known one, so the time taken doesn't tell them apart.
  const [codeHash, next] = await Promise.all([
    recoveryCodeHash(c.env.AUTH_PEPPER, user?._id ?? "usr_unknown", code),
    hashPassword(password, c.env.AUTH_PEPPER),
  ]);
  const used =
    user && !user.demo && user.password
      ? await db(c).users.updateOne({ _id: user._id, recoveryCodes: codeHash }, { $pull: { recoveryCodes: codeHash }, $set: { password: next } })
      : null;
  if (!user || !used?.modifiedCount) return c.json({ error: "That email and recovery code don't match an account." }, 401);
  await Promise.all([giveBack(db(c), key, 15 * MINUTE), db(c).sessions.deleteMany({ userId: user._id })]);
  return signIn(c, user);
});

api.post("/auth/logout", async (c) => {
  const token = readCookie(c.req.header("cookie"), cookieName(secure(c)));
  if (token) await db(c).sessions.deleteOne({ _id: await sha256(token) });
  c.header("set-cookie", clearedCookie(secure(c)));
  return c.body(null, 204);
});

/** What an API key can reach: workflows and runs in its own workspace. Never accounts, members or keys. */
const KEY_PATHS = /^\/api\/(workflows|runs|overview)(\/|$)/;

// Everything below needs a signed-in user, or (for workflows and runs) an API key.
api.use("*", async (c, next) => {
  const authorization = c.req.header("authorization");
  if (authorization !== undefined) {
    // A request that brings a key is judged by the key alone, even if a session cookie came along.
    const key = /^Bearer (kw_[A-Za-z0-9_-]{40})$/.exec(authorization)?.[1];
    // The key's own signature is checked first, with CPU only: a made-up key costs no database lookup.
    const doc = key && (await apiKeyValid(key, c.env.AUTH_PEPPER)) ? await db(c).apiKeys.findOne({ _id: await sha256url(key) }) : null;
    if (!doc) return c.json({ error: "That API key isn't valid. It may have been revoked." }, 401);
    if (!KEY_PATHS.test(c.req.path)) {
      return c.json({ error: "API keys work with workflows and runs only. Use the dashboard for account and team settings." }, 403);
    }
    c.set("key", doc);
    c.set("session", { _id: "", userId: doc.userId, demo: false, workspaceIds: [], createdAt: doc.createdAt, expiresAt: new Date(0) });
    c.var.later.push(touchApiKey(db(c), doc, Date.now()));
    return next();
  }
  const session = await findSession(db(c), readCookie(c.req.header("cookie"), cookieName(secure(c))));
  if (!session) return c.json({ error: "Log in to continue" }, 401);
  c.set("session", session);
  return next();
});

const DEMO_SHARED = "The demo account is shared by everyone, so it can't do this. Create a free account instead.";

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
    return c.json({ error: "That isn't your current password.", issues: [{ path: ["current"], message: "Wrong password" }, { path: ["password"], message: "Wrong password" }] }, 403);
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

/**
 * Makes a fresh set of recovery codes and returns them, once. Only their hashes are kept, and any
 * older codes stop working. Needs the password, so a borrowed session can't quietly take over the
 * way back into the account.
 */
api.post("/auth/recovery-codes", async (c) => {
  const parsed = recoveryCodesInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  const user = await confirmPassword(c, parsed.data.password);
  if (user instanceof Response) return user;
  const codes = newRecoveryCodes(LIMITS.recoveryCodes);
  const hashes = await Promise.all(codes.map((code) => recoveryCodeHash(c.env.AUTH_PEPPER, user._id, code)));
  await db(c).users.updateOne({ _id: user._id }, { $set: { recoveryCodes: hashes } });
  return c.json({ codes });
});

/** Deletes the account with everything in it: workspaces, workflows, runs, sessions, memberships and API keys. */
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
  // Then every other way in: its API keys and memberships, and the members, invite links and keys
  // of the workspaces it owns.
  await deleteAccountAccess(db(c), ownerId);
  await db(c).workflows.deleteMany({ ownerId });
  await db(c).runs.deleteMany({ ownerId });
  await db(c).workspaces.deleteMany({ ownerId });
  c.header("set-cookie", clearedCookie(secure(c)));
  return c.body(null, 204);
});

// ---------- Workspaces ----------

api.get("/workspaces", async (c) => c.json(await listWorkspacesFor(db(c), c.var.session.userId)));

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

// ---------- Teams: members and invite links ----------

const NOT_OWNER = "Only the workspace's owner can do this.";

/** The workspace, if the signed-in user owns it; otherwise the response that says why not. */
async function ownedWorkspace(c: C, id: string): Promise<WorkspaceDoc | Response> {
  const ws = await db(c).workspaces.findOne({ _id: id });
  const mine = ws?.ownerId === c.var.session.userId;
  // Someone who isn't in the workspace learns nothing about it, not even that it exists.
  if (!ws || (!mine && !(await accessTo(db(c), id, c.var.session.userId)))) return c.json({ error: "No workspace with that id" }, 404);
  return mine ? ws : c.json({ error: NOT_OWNER }, 403);
}

api.get("/workspaces/:id/team", async (c) => {
  const id = c.req.param("id");
  const [ws, access] = await Promise.all([db(c).workspaces.findOne({ _id: id }), accessTo(db(c), id, c.var.session.userId)]);
  if (!ws || !access) return c.json({ error: "No workspace with that id" }, 404);
  return c.json(await team(db(c), ws, c.var.session.userId, Date.now()));
});

api.post("/workspaces/:id/invites", async (c) => {
  const parsed = inviteInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  if (c.var.session.demo) return c.json({ error: DEMO_SHARED }, 403);
  const ws = await ownedWorkspace(c, c.req.param("id"));
  if (ws instanceof Response) return ws;
  if (ws.personal) return c.json({ error: "Your personal workspace is only for you. Make another workspace to share." }, 409);
  const invite = await createInvite(db(c), ws, parsed.data.role, Date.now());
  if (invite === "full") {
    return c.json({ error: `A workspace can have ${LIMITS.invitesPerWorkspace} open invite links. Revoke one to make room.` }, 409);
  }
  return c.json(invite, 201);
});

api.delete("/workspaces/:id/invites/:invite", async (c) => {
  const ws = await ownedWorkspace(c, c.req.param("id"));
  if (ws instanceof Response) return ws;
  const res = await db(c).invites.deleteOne({ _id: c.req.param("invite"), workspaceId: ws._id });
  return res.deletedCount ? c.body(null, 204) : c.json({ error: "No invite link with that id" }, 404);
});

api.patch("/workspaces/:id/members/:user", async (c) => {
  const parsed = roleChange.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  const ws = await ownedWorkspace(c, c.req.param("id"));
  if (ws instanceof Response) return ws;
  const user = c.req.param("user");
  const res = await db(c).members.updateOne({ _id: memberId(ws._id, user), workspaceId: ws._id, userId: user }, { $set: { role: parsed.data.role } });
  return res.matchedCount ? c.body(null, 204) : c.json({ error: "No member with that id" }, 404);
});

/** The owner removes a member, or a member leaves (their own id). The owner can't be removed. */
api.delete("/workspaces/:id/members/:user", async (c) => {
  const { id, user } = c.req.param();
  if (user !== c.var.session.userId) {
    const ws = await ownedWorkspace(c, id);
    if (ws instanceof Response) return ws;
  }
  if (await removeMember(db(c), id, user)) return c.body(null, 204);
  const own = user === c.var.session.userId && (await db(c).workspaces.findOne({ _id: id, ownerId: user }, { projection: { _id: 1 } }));
  return own
    ? c.json({ error: "You own this workspace, so you can't leave it. Delete it instead." }, 409)
    : c.json({ error: "No member with that id" }, 404);
});

const INVITE_GONE = "This invite link doesn't work any more. It may have expired or been revoked. Ask for a new one.";
const INVITE_USED = "Everyone this invite link could let in has joined. Ask for a new one.";

/** What an invite link offers, shown before joining. */
api.get("/invites/:token", async (c) => {
  const token = inviteToken.safeParse(c.req.param("token"));
  const found = token.success ? await findInvite(db(c), token.data, Date.now()) : ({ ok: false, reason: "gone" } as const);
  if (!found.ok) return found.reason === "used" ? c.json({ error: INVITE_USED }, 410) : c.json({ error: INVITE_GONE }, 404);
  const { invite, workspace } = found;
  const [owner, access] = await Promise.all([
    db(c).users.findOne({ _id: workspace.ownerId }, { projection: { name: 1 } }),
    accessTo(db(c), workspace._id, c.var.session.userId),
  ]);
  return c.json({ workspaceId: workspace._id, workspaceName: workspace.name, ownerName: owner?.name ?? "Someone", role: invite.role, already: access !== null });
});

api.post("/invites/:token/accept", async (c) => {
  // Everyone shares the demo account, so letting it join would open the workspace to anyone.
  if (c.var.session.demo) return c.json({ error: DEMO_SHARED }, 403);
  const token = inviteToken.safeParse(c.req.param("token"));
  const res = token.success ? await acceptInvite(db(c), token.data, c.var.session.userId, Date.now()) : ({ ok: false, reason: "gone" } as const);
  if (res.ok) return c.json({ workspaceId: res.workspaceId });
  if (res.reason === "gone") return c.json({ error: INVITE_GONE }, 404);
  if (res.reason === "used") return c.json({ error: INVITE_USED }, 410);
  if (res.reason === "full") {
    return c.json({ error: `This workspace already has ${LIMITS.membersPerWorkspace} members, which is the most it can have.` }, 409);
  }
  return c.json({ error: `You're in ${LIMITS.joinedWorkspacesPerAccount} shared workspaces, which is the most an account can join. Leave one first.` }, 409);
});

// ---------- API keys ----------

api.get("/keys", async (c) => c.json(await listApiKeys(db(c), c.var.session.userId)));

api.post("/keys", async (c) => {
  const parsed = apiKeyInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  if (c.var.session.demo) return c.json({ error: DEMO_SHARED }, 403);
  const access = await accessTo(db(c), parsed.data.workspaceId, c.var.session.userId);
  if (!access) return c.json({ error: "No workspace with that id" }, 404);
  // A key never has more rights than the person who made it (checked again on every request).
  if (parsed.data.access === "write" && !canEdit(access.role)) {
    return c.json({ error: "You're a viewer in this workspace, so your keys can only read." }, 403);
  }
  const key = await createApiKey(db(c), c.var.session.userId, parsed.data.workspaceId, access.ownerId, parsed.data, Date.now(), c.env.AUTH_PEPPER);
  if (key === "full") return c.json({ error: `An account can have ${LIMITS.apiKeysPerAccount} API keys. Revoke one to make room.` }, 409);
  return c.json(key, 201);
});

api.delete("/keys/:id", async (c) => {
  const res = await db(c).apiKeys.deleteOne({ _id: c.req.param("id"), userId: c.var.session.userId });
  return res.deletedCount ? c.body(null, 204) : c.json({ error: "No API key with that id" }, 404);
});

/**
 * Which of the user's workspaces a workflow or run is in, so a link opened while another workspace is
 * selected can switch to the right one instead of saying it doesn't exist.
 */
api.get("/locate/:kind/:id", async (c) => {
  const { kind, id } = c.req.param();
  const filter = { _id: id, workspaceId: { $in: [...c.var.session.workspaceIds, ...(await joinedWorkspaceIds(db(c), c.var.session.userId))] } };
  const options = { projection: { workspaceId: 1 } };
  const doc =
    kind === "workflow" ? await db(c).workflows.findOne(filter, options) : kind === "run" ? await db(c).runs.findOne(filter, options) : null;
  return doc ? c.json({ workspaceId: doc.workspaceId }) : c.json({ error: "Not found in any of your workspaces" }, 404);
});

// ---------- Workflows and runs (inside one workspace) ----------
//
// The dashboard says which workspace it is looking at with the x-knotwork-workspace header. The
// session lists the workspaces this user owns, so checking those needs no extra query; for a
// workspace they joined, their role is read from the database each time. A request with an API key
// needs no header: the key says which workspace.

const scoped = new Hono<{ Bindings: Env; Variables: Vars }>();

const WORKSPACE_ID = /^ws_[A-Za-z0-9_-]{1,60}$/;
const VIEWER = "You're a viewer in this workspace, so you can look but not change or run anything. Ask its owner for the editor role.";
const READ_KEY = "This API key can only read. Make one with write access to change or run workflows.";

scoped.use("*", async (c, next) => {
  const { key, session } = c.var;
  const asked = c.req.header("x-knotwork-workspace") ?? "";
  let workspace = asked;
  let access: { role: Role; ownerId: string } | null = null;
  if (key) {
    // A key works in the one workspace it was made for; naming another one is refused, not ignored.
    if (asked && asked !== key.workspaceId) return c.json({ error: "This API key belongs to another workspace." }, 403);
    workspace = key.workspaceId;
    // The maker's role is read again on every request, so a key stops working when they're removed
    // and can't write once they're made a viewer. (An owner's keys are deleted with the workspace.)
    access = key.ownerId === key.userId ? { role: "owner", ownerId: key.userId } : await accessTo(db(c), workspace, key.userId);
    if (!access) return c.json({ error: "That API key isn't valid. It may have been revoked." }, 401);
  } else if (session.workspaceIds.includes(workspace)) {
    access = { role: "owner", ownerId: session.userId };
  } else if (WORKSPACE_ID.test(workspace)) {
    // A workspace the user joined, or one of their own made after this session started.
    access = await accessTo(db(c), workspace, session.userId);
    if (access?.role === "owner") await db(c).sessions.updateOne({ _id: session._id }, { $addToSet: { workspaceIds: workspace } });
  }
  if (!access) return c.json({ error: "No workspace with that id" }, 404);
  const canWrite = canEdit(access.role) && (!key || key.access === "write");
  // Reading is GET; every other method changes something or starts a run.
  if (!canWrite && c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.json({ error: canEdit(access.role) ? READ_KEY : VIEWER }, 403);
  }
  c.set("workspace", workspace);
  c.set("role", access.role);
  c.set("canWrite", canWrite);
  c.set("ownerId", access.ownerId);
  return next();
});

/**
 * A webhook URL starts runs for whoever holds it, so it is only shown to those who may start runs:
 * viewers and read-only keys get the workflow without it.
 */
const shown = <T extends Workflow | WorkflowSummary>(c: C, wf: T): T => (c.var.canWrite ? wf : { ...wf, hookKey: "" });

scoped.get("/workflows", async (c) => c.json((await listWorkflows(db(c), c.var.workspace)).map((wf) => shown(c, wf))));

/** Everything the sidebar and home page show, in one request: the app polls this while it's open. */
scoped.get("/overview", async (c) => {
  const now = Date.now();
  const [workflows, runs, runsThisHour, runsLimit] = await Promise.all([
    listWorkflows(db(c), c.var.workspace),
    listRuns(db(c), c.var.workspace, undefined, 100),
    // Runs are counted against the workspace's owner, whoever is looking.
    counterValue(db(c), runCounter(c.var.ownerId), HOUR, now),
    runLimit(db(c), c.var.ownerId, now),
  ]);
  return c.json({ workflows: workflows.map((wf) => shown(c, wf)), runs, runsThisHour, runsLimit: runsLimit ?? 0 });
});

scoped.post("/workflows", async (c) => {
  const parsed = workflowInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(issues(parsed.error), 400);
  const res = await insertWorkflow(db(c), c.var.workspace, c.var.ownerId, parsed.data, Date.now(), await newHookKey(c.env.AUTH_PEPPER));
  if (res === "full") return c.json({ error: `A workspace can hold ${LIMITS.workflowsPerWorkspace} workflows. Delete one to make room.` }, 409);
  if (res === "gone") return c.json({ error: "No workspace with that id" }, 404);
  return c.json(res, 201);
});

scoped.get("/workflows/:id", async (c) => {
  const wf = await getWorkflow(db(c), c.req.param("id"), c.var.workspace);
  return wf ? c.json(shown(c, wf)) : c.json({ error: "No workflow with that id" }, 404);
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

    const text = await c.req.text();
    if (text.length > LIMITS.runInputBytes) return c.json({ error: `Payload is larger than ${LIMITS.runInputBytes / 1000} KB` }, 413);
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
    c.var.later.push(advance(db(c), runId));
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
