import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import worker from "../worker/index";
import { collections, ensureIndexes, type Env } from "../worker/mongo";
import { dropAll } from "./dropAll";

/**
 * The HTTP API end to end: sign-up, login, sessions, workspace isolation, password change and
 * account deletion. Like the engine tests, they need a MongoDB (MONGODB_TEST_URI) and use a
 * throwaway database that is dropped at the end.
 */
const uri = process.env.MONGODB_TEST_URI;

describe.skipIf(!uri)("HTTP API", () => {
  const dbName = `knotwork_api_test_${Date.now()}`;
  const env = { MONGODB_URI: uri!, MONGODB_DB: dbName, AUTH_PEPPER: "test-pepper-0123456789abcdef", ASSETS: {} } as unknown as Env;

  afterAll(async () => {
    const client = await MongoClient.connect(uri!);
    await dropAll(client.db(dbName));
    await client.close();
  });

  interface Options {
    body?: unknown;
    raw?: string;
    cookie?: string;
    ws?: string;
    origin?: string;
  }

  /** One request through the Worker, waiting for its background work (and connection close). */
  async function call(method: string, path: string, { body, raw, cookie, ws, origin = "http://kw.test" }: Options = {}) {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} };
    const headers = new Headers({ "content-type": "application/json", origin });
    if (cookie) headers.set("cookie", cookie);
    if (ws) headers.set("x-knotwork-workspace", ws);
    const res = await worker.fetch(
      new Request(`http://kw.test${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }),
      env,
      ctx as unknown as ExecutionContext,
    );
    await Promise.all(pending);
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
  }

  const flow = (name: string, trigger: unknown = { type: "manual" }) => ({
    name,
    description: "",
    enabled: true,
    trigger,
    steps: [{ id: "log_1", name: "Log", type: "log", retry: { max: 0, backoffSeconds: 5 }, config: { message: "hi" } }],
  });

  let alice = { cookie: "", ws: "" };
  let bob = { cookie: "", ws: "" };

  beforeAll(async () => {
    const client = await MongoClient.connect(uri!);
    await ensureIndexes(collections(client.db(dbName)));
    await client.close();
    const a = await call("POST", "/api/auth/signup", { body: { name: "Alice", email: "Alice@Example.com", password: "alice-password-1" } });
    expect(a.status).toBe(200);
    alice = { cookie: a.cookie, ws: a.body.workspaces[0].id };
    const b = await call("POST", "/api/auth/signup", { body: { name: "Bob", email: "bob@example.com", password: "bob-password-12" } });
    bob = { cookie: b.cookie, ws: b.body.workspaces[0].id };
  });

  it("signs up into a Personal workspace and refuses a second account with the same email", async () => {
    const me = await call("GET", "/api/me", { cookie: alice.cookie });
    expect(me.body.user).toMatchObject({ name: "Alice", email: "alice@example.com", demo: false });
    expect(me.body.workspaces).toMatchObject([{ name: "Personal", personal: true }]);
    const again = await call("POST", "/api/auth/signup", { body: { name: "A2", email: "alice@example.com", password: "another-password" } });
    expect(again.status).toBe(409);
    // Trying many emails that exist (to learn who has an account) is cut off.
    const statuses = [];
    for (let i = 0; i < 10; i++) {
      statuses.push((await call("POST", "/api/auth/signup", { body: { name: "A2", email: "alice@example.com", password: "another-password" } })).status);
    }
    expect(statuses.at(-1)).toBe(429);
  });

  it("logs in with the right password only, and logs out", async () => {
    expect((await call("POST", "/api/auth/login", { body: { email: "alice@example.com", password: "wrong-password" } })).status).toBe(401);
    const ok = await call("POST", "/api/auth/login", { body: { email: "ALICE@example.com", password: "alice-password-1" } });
    expect(ok.status).toBe(200);
    expect(ok.cookie).toMatch(/^kw_session=/);
    expect((await call("POST", "/api/auth/logout", { cookie: ok.cookie })).status).toBe(204);
    expect((await call("GET", "/api/me", { cookie: ok.cookie })).status).toBe(401);
    expect((await call("GET", "/api/me")).status).toBe(401);
  });

  it("keeps each account to its own workspaces", async () => {
    const wf = await call("POST", "/api/workflows", { cookie: alice.cookie, ws: alice.ws, body: flow("Alice's") });
    expect(wf.status).toBe(201);
    // Bob naming Alice's workspace, or his own with Alice's workflow id: nothing.
    expect((await call("GET", "/api/workflows", { cookie: bob.cookie, ws: alice.ws })).status).toBe(404);
    expect((await call("GET", `/api/workflows/${wf.body.id}`, { cookie: bob.cookie, ws: bob.ws })).status).toBe(404);
    expect((await call("DELETE", `/api/workflows/${wf.body.id}`, { cookie: bob.cookie, ws: alice.ws })).status).toBe(404);
    expect((await call("PATCH", `/api/workspaces/${alice.ws}`, { cookie: bob.cookie, body: { name: "Mine now" } })).status).toBe(404);
    expect((await call("GET", `/api/locate/workflow/${wf.body.id}`, { cookie: bob.cookie })).status).toBe(404);
    // Alice finds it from any of her workspaces.
    const side = await call("POST", "/api/workspaces", { cookie: alice.cookie, body: { name: "Side" } });
    const located = await call("GET", `/api/locate/workflow/${wf.body.id}`, { cookie: alice.cookie, ws: side.body.id });
    expect(located.body).toEqual({ workspaceId: alice.ws });
  });

  it("refuses writes from other sites and oversized bodies", async () => {
    expect((await call("POST", "/api/workspaces", { cookie: alice.cookie, origin: "https://evil.example", body: { name: "x" } })).status).toBe(403);
    expect((await call("POST", "/api/workspaces", { cookie: alice.cookie, origin: "null", body: { name: "x" } })).status).toBe(403);
    expect((await call("POST", "/api/workspaces", { cookie: alice.cookie, raw: JSON.stringify({ name: "x".repeat(70_000) }) })).status).toBe(413);
  });

  it("changing the password keeps this session and ends the others", async () => {
    const other = await call("POST", "/api/auth/login", { body: { email: "bob@example.com", password: "bob-password-12" } });
    const wrong = await call("POST", "/api/auth/password", { cookie: bob.cookie, body: { current: "not-it-at-all", next: "bob-password-new" } });
    expect(wrong.status).toBe(403);
    const changed = await call("POST", "/api/auth/password", { cookie: bob.cookie, body: { current: "bob-password-12", next: "bob-password-new" } });
    expect(changed.status).toBe(204);
    expect((await call("GET", "/api/me", { cookie: bob.cookie })).status).toBe(200);
    expect((await call("GET", "/api/me", { cookie: other.cookie })).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { body: { email: "bob@example.com", password: "bob-password-new" } })).status).toBe(200);
  });

  it("deleting the account removes it with its webhooks, and the email can sign up again", async () => {
    const c = await call("POST", "/api/auth/signup", { body: { name: "Cy", email: "cy@example.com", password: "cy-password-123" } });
    const ws = c.body.workspaces[0].id;
    const hook = await call("POST", "/api/workflows", { cookie: c.cookie, ws, body: flow("Hook", { type: "webhook" }) });
    expect((await call("POST", `/hooks/${hook.body.hookKey}`, { body: {} })).status).toBe(202);
    expect((await call("POST", "/api/auth/delete-account", { cookie: c.cookie, body: { password: "nope-nope-nope" } })).status).toBe(403);
    expect((await call("POST", "/api/auth/delete-account", { cookie: c.cookie, body: { password: "cy-password-123" } })).status).toBe(204);
    expect((await call("GET", "/api/me", { cookie: c.cookie })).status).toBe(401);
    expect((await call("POST", `/hooks/${hook.body.hookKey}`, { body: {} })).status).toBe(404);
    const again = await call("POST", "/api/auth/signup", { body: { name: "Cy", email: "cy@example.com", password: "cy-password-456" } });
    expect(again.status).toBe(200);
  });

  it("gives an account that lost its Personal workspace a new one", async () => {
    const client = await MongoClient.connect(uri!);
    await client.db(dbName).collection("workspaces").deleteMany({ _id: bob.ws } as never);
    await client.close();
    const me = await call("GET", "/api/me", { cookie: bob.cookie });
    expect(me.body.workspaces).toMatchObject([{ name: "Personal", personal: true }]);
    const ws = me.body.workspaces[0].id;
    expect((await call("GET", "/api/workflows", { cookie: bob.cookie, ws })).status).toBe(200);
  });

  it("lets anyone into the shared demo, but not change its password", async () => {
    const demo = await call("POST", "/api/auth/demo");
    expect(demo.body.user).toMatchObject({ demo: true });
    const res = await call("POST", "/api/auth/password", { cookie: demo.cookie, body: { current: "x", next: "demo-password-1" } });
    expect(res.status).toBe(403);
  });
});
