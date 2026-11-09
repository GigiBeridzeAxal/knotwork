import { createHmac } from "node:crypto";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "../shared/limits";
import worker from "../worker/index";
import { collections, type Collections, ensureIndexes, type Env } from "../worker/mongo";
import { dropAll } from "./dropAll";
import { loadSecrets } from "../worker/secrets";

/**
 * The HTTP API for workspace secrets, signed webhooks and "Run again", end to end through the Worker.
 * Needs a MongoDB (MONGODB_TEST_URI); uses a throwaway database that is dropped at the end.
 */
const uri = process.env.MONGODB_TEST_URI;

describe.skipIf(!uri)("HTTP API: secrets, signed webhooks and run again", () => {
  const dbName = `knotwork_api2_test_${Date.now()}`;
  const env = { MONGODB_URI: uri!, MONGODB_DB: dbName, AUTH_PEPPER: "test-pepper-0123456789abcdef", ASSETS: {} } as unknown as Env;
  let client: MongoClient;
  let c: Collections;

  /** Every response body this file has seen, to check no secret value ever left the server. */
  const seen: string[] = [];

  afterAll(async () => {
    await dropAll(client.db(dbName));
    await client.close();
  });

  interface Options {
    body?: unknown;
    raw?: string;
    cookie?: string;
    ws?: string;
    origin?: string;
    ip?: string;
    headers?: Record<string, string>;
  }

  /** One request through the Worker, waiting for its background work (and connection close). */
  async function call(method: string, path: string, { body, raw, cookie, ws, origin = "http://kw.test", ip, headers: extra }: Options = {}) {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} };
    const headers = new Headers({ "content-type": "application/json", origin, ...extra });
    if (cookie) headers.set("cookie", cookie);
    if (ws) headers.set("x-knotwork-workspace", ws);
    if (ip) headers.set("cf-connecting-ip", ip);
    const res = await worker.fetch(
      new Request(`http://kw.test${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }),
      env,
      ctx as unknown as ExecutionContext,
    );
    await Promise.all(pending);
    const text = await res.text();
    seen.push(text);
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
  }

  const retry = { max: 0, backoffSeconds: 5 };
  const flow = (name: string, trigger: unknown, steps: unknown[] = [{ id: "log_1", name: "Log", type: "log", retry, config: { message: "hi" } }]) => ({
    name,
    description: "",
    enabled: true,
    trigger,
    steps,
  });

  type Account = { cookie: string; ws: string; id: string };
  let alice: Account;
  let bob: Account;

  async function signup(name: string, email: string, password: string): Promise<Account> {
    const res = await call("POST", "/api/auth/signup", { body: { name, email, password } });
    expect(res.status).toBe(200);
    return { cookie: res.cookie, ws: res.body.workspaces[0].id, id: res.body.user.id };
  }

  /** New accounts may start 10 runs an hour; tests that start runs begin from an empty count. */
  const freshRunBudget = (userId: string) => c.counters.deleteMany({ _id: { $regex: `^runs:${userId}:` } });

  beforeAll(async () => {
    client = await MongoClient.connect(uri!);
    c = collections(client.db(dbName));
    await ensureIndexes(c);
    alice = await signup("Alice", "alice@example.com", "alice-password-1");
    bob = await signup("Bob", "bob@example.com", "bob-password-12");
  });

  // ---------- Secrets ----------

  const VALUE = "sk_live_alice_5e4d3c2b1a";

  it("stores a secret and lists only its name and date, never the value", async () => {
    const put = await call("PUT", "/api/secrets/API_KEY", { cookie: alice.cookie, ws: alice.ws, body: { value: VALUE } });
    expect(put.status).toBe(200);
    expect(Object.keys(put.body).sort()).toEqual(["name", "updatedAt"]);
    expect(put.body.name).toBe("API_KEY");

    const list = await call("GET", "/api/secrets", { cookie: alice.cookie, ws: alice.ws });
    expect(list.status).toBe(200);
    expect(list.body).toEqual([{ name: "API_KEY", updatedAt: put.body.updatedAt }]);

    // Replacing the value keeps one secret.
    const again = await call("PUT", "/api/secrets/API_KEY", { cookie: alice.cookie, ws: alice.ws, body: { value: `${VALUE}_v2` } });
    expect(again.status).toBe(200);
    expect((await call("GET", "/api/secrets", { cookie: alice.cookie, ws: alice.ws })).body).toHaveLength(1);
    expect(await c.secrets.countDocuments({ workspaceId: alice.ws })).toBe(1);
    // The database holds only ciphertext.
    expect(JSON.stringify(await c.secrets.find({}).toArray())).not.toContain("alice_5e4d3c2b1a");
  });

  it("deletes a secret, and says when there is none to delete", async () => {
    await call("PUT", "/api/secrets/TO_DELETE", { cookie: alice.cookie, ws: alice.ws, body: { value: "delete-me-please" } });
    expect((await call("DELETE", "/api/secrets/TO_DELETE", { cookie: alice.cookie, ws: alice.ws })).status).toBe(204);
    expect((await call("DELETE", "/api/secrets/TO_DELETE", { cookie: alice.cookie, ws: alice.ws })).status).toBe(404);
    const names = (await call("GET", "/api/secrets", { cookie: alice.cookie, ws: alice.ws })).body.map((s: { name: string }) => s.name);
    expect(names).not.toContain("TO_DELETE");
  });

  it("checks secret names and value lengths", async () => {
    const put = (name: string, body: unknown) => call("PUT", `/api/secrets/${name}`, { cookie: alice.cookie, ws: alice.ws, body });
    expect((await put("api_key", { value: "long-enough-value" })).status).toBe(400);
    expect((await put("9KEY", { value: "long-enough-value" })).status).toBe(400);
    expect((await put("K".repeat(41), { value: "long-enough-value" })).status).toBe(400);
    expect((await put("SHORT", { value: "1234567" })).status).toBe(400);
    expect((await put("LONG", { value: "x".repeat(4001) })).status).toBe(400);
    expect((await put("NO_BODY", undefined)).status).toBe(400);
    expect((await put("MIN_LEN", { value: "12345678" })).status).toBe(200);
    expect((await put("MAX_LEN", { value: "x".repeat(4000) })).status).toBe(200);
    await call("DELETE", "/api/secrets/MIN_LEN", { cookie: alice.cookie, ws: alice.ws });
    await call("DELETE", "/api/secrets/MAX_LEN", { cookie: alice.cookie, ws: alice.ws });
  });

  it("keeps 20 secrets per workspace, but still lets one at the limit be replaced", async () => {
    const side = await call("POST", "/api/workspaces", { cookie: alice.cookie, body: { name: "Many secrets" } });
    const ws = side.body.id;
    for (let i = 0; i < LIMITS.secretsPerWorkspace; i++) {
      expect((await call("PUT", `/api/secrets/KEY_${i}`, { cookie: alice.cookie, ws, body: { value: `value-number-${i}` } })).status).toBe(200);
    }
    const over = await call("PUT", "/api/secrets/ONE_TOO_MANY", { cookie: alice.cookie, ws, body: { value: "value-over-limit" } });
    expect(over.status).toBe(409);
    expect(await c.secrets.countDocuments({ workspaceId: ws })).toBe(LIMITS.secretsPerWorkspace);
    expect((await call("PUT", "/api/secrets/KEY_0", { cookie: alice.cookie, ws, body: { value: "a-replaced-value" } })).status).toBe(200);
    expect((await call("GET", "/api/secrets", { cookie: alice.cookie, ws })).body).toHaveLength(LIMITS.secretsPerWorkspace);
    // Other workspaces have their own 20.
    expect((await call("PUT", "/api/secrets/ELSEWHERE", { cookie: alice.cookie, ws: alice.ws, body: { value: "another-workspace" } })).status).toBe(200);

    // Deleting the workspace deletes its secrets.
    expect((await call("DELETE", `/api/workspaces/${ws}`, { cookie: alice.cookie })).status).toBe(204);
    expect(await c.secrets.countDocuments({ workspaceId: ws })).toBe(0);
    expect(await c.secrets.countDocuments({ workspaceId: alice.ws })).toBeGreaterThan(0);
  });

  it("doesn't let another account see, set or delete a workspace's secrets", async () => {
    expect((await call("GET", "/api/secrets", { cookie: bob.cookie, ws: alice.ws })).status).toBe(404);
    expect((await call("PUT", "/api/secrets/API_KEY", { cookie: bob.cookie, ws: alice.ws, body: { value: "bob-overwrites" } })).status).toBe(404);
    expect((await call("DELETE", "/api/secrets/API_KEY", { cookie: bob.cookie, ws: alice.ws })).status).toBe(404);
    expect((await call("GET", "/api/secrets", { cookie: alice.cookie, ws: alice.ws })).body.map((s: { name: string }) => s.name)).toContain("API_KEY");
    // Bob's own workspace has none of Alice's.
    expect((await call("GET", "/api/secrets", { cookie: bob.cookie, ws: bob.ws })).body).toEqual([]);
    expect((await call("GET", "/api/secrets", { cookie: alice.cookie })).status).toBe(404);
  });

  it("doesn't let the shared demo account keep secrets", async () => {
    const demo = await call("POST", "/api/auth/demo");
    const ws = demo.body.workspaces[0].id;
    expect((await call("PUT", "/api/secrets/API_KEY", { cookie: demo.cookie, ws, body: { value: "demo-secret-value" } })).status).toBe(403);
    expect((await call("DELETE", "/api/secrets/API_KEY", { cookie: demo.cookie, ws })).status).toBe(403);
    expect((await call("GET", "/api/secrets", { cookie: demo.cookie, ws })).body).toEqual([]);
  });

  it("deletes an account's secrets with the account", async () => {
    const cy = await signup("Cy", "cy@example.com", "cy-password-123");
    const side = await call("POST", "/api/workspaces", { cookie: cy.cookie, body: { name: "Side" } });
    await call("PUT", "/api/secrets/CY_KEY", { cookie: cy.cookie, ws: cy.ws, body: { value: "cy-secret-value" } });
    await call("PUT", "/api/secrets/CY_KEY", { cookie: cy.cookie, ws: side.body.id, body: { value: "cy-secret-value" } });
    expect(await c.secrets.countDocuments({ ownerId: cy.id })).toBe(2);
    expect((await call("POST", "/api/auth/delete-account", { cookie: cy.cookie, body: { password: "cy-password-123" } })).status).toBe(204);
    expect(await c.secrets.countDocuments({ ownerId: cy.id })).toBe(0);
    expect(await c.secrets.countDocuments({ workspaceId: { $in: [cy.ws, side.body.id] } })).toBe(0);
  });

  // ---------- Signed webhooks ----------

  const GH_SECRET = "gh-signing-secret-123";
  const STRIPE_SECRET = "whsec_stripe_signing_456";
  const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");
  const hook = (key: string, raw: string, headers: Record<string, string> = {}) => call("POST", `/hooks/${key}`, { raw, headers });
  const runsOf = (workflowId: string) => c.runs.countDocuments({ workflowId });
  const runCount = async (userId: string) =>
    (await c.counters.find({ _id: { $regex: `^runs:${userId}:` } }).toArray()).reduce((sum, d) => sum + d.n, 0);

  it("refuses unsigned or wrongly signed GitHub calls without starting a run, and accepts a signed one", async () => {
    await freshRunBudget(alice.id);
    const wf = await call("POST", "/api/workflows", {
      cookie: alice.cookie,
      ws: alice.ws,
      body: flow("GitHub", { type: "webhook", verify: { provider: "github", secret: "GH_SIGNING" } }, [
        { id: "t", name: "T", type: "transform", retry, config: { output: "{{ trigger.body.action }}" } },
      ]),
    });
    expect(wf.status).toBe(201);
    const key = wf.body.hookKey;
    const body = JSON.stringify({ action: "opened", number: 7 });
    const good = { "x-hub-signature-256": `sha256=${hmac(GH_SECRET, body)}` };

    // The signing secret isn't set yet: even a signed call is refused.
    const unset = await hook(key, body, good);
    expect(unset.status).toBe(401);
    expect(unset.body.error).toMatch(/signing secret isn't set/);
    // Whoever holds the webhook URL doesn't learn the secret's name.
    expect(unset.body.error).not.toMatch(/GH_SIGNING/);

    await call("PUT", "/api/secrets/GH_SIGNING", { cookie: alice.cookie, ws: alice.ws, body: { value: GH_SECRET } });
    expect((await hook(key, body)).status).toBe(401);
    expect((await hook(key, body, { "x-hub-signature-256": `sha256=${hmac("not-the-secret", body)}` })).status).toBe(401);
    expect((await hook(key, `${body} `, good)).status).toBe(401);
    expect((await hook(key, body, { "x-hub-signature-256": "sha256=zz" })).status).toBe(401);
    // None of those started a run or took one of the account's runs this hour.
    expect(await runsOf(wf.body.id)).toBe(0);
    expect(await runCount(alice.id)).toBe(0);

    const ok = await hook(key, body, good);
    expect(ok.status).toBe(202);
    expect(await runsOf(wf.body.id)).toBe(1);
    expect(await runCount(alice.id)).toBe(1);
    const run = await call("GET", `/api/runs/${ok.body.runId}`, { cookie: alice.cookie, ws: alice.ws });
    expect(run.body.status).toBe("succeeded");
    expect(run.body.logs[0].output).toBe("opened");
  });

  it("unwraps GitHub's default form-encoded delivery, so the event's fields are where templates expect them", async () => {
    await freshRunBudget(alice.id);
    const wf = await call("POST", "/api/workflows", {
      cookie: alice.cookie,
      ws: alice.ws,
      body: flow("GitHub form", { type: "webhook", verify: { provider: "github", secret: "GH_SIGNING" } }, [
        { id: "t", name: "T", type: "transform", retry, config: { output: "{{ trigger.body.ref }}" } },
      ]),
    });
    const body = `payload=${encodeURIComponent(JSON.stringify({ ref: "refs/heads/main" }))}`;
    const sent = await hook(wf.body.hookKey, body, {
      "content-type": "application/x-www-form-urlencoded",
      "x-hub-signature-256": `sha256=${hmac(GH_SECRET, body)}`,
    });
    expect(sent.status).toBe(202);
    const run = await call("GET", `/api/runs/${sent.body.runId}`, { cookie: alice.cookie, ws: alice.ws });
    expect(run.body.logs[0].output).toBe("refs/heads/main");
  });

  it("trims a secret's value when it is saved", async () => {
    const put = await call("PUT", "/api/secrets/PADDED", { cookie: alice.cookie, ws: alice.ws, body: { value: "  padded-value-123\n" } });
    expect(put.status).toBeLessThan(300);
    expect(await loadSecrets(c, env.AUTH_PEPPER, alice.ws, ["PADDED"])).toEqual({ PADDED: "padded-value-123" });
    expect((await call("PUT", "/api/secrets/SPACES", { cookie: alice.cookie, ws: alice.ws, body: { value: "   abc    " } })).status).toBe(400);
  });

  it("checks Stripe signatures, their age, and accepts one good signature among several", async () => {
    await freshRunBudget(alice.id);
    await call("PUT", "/api/secrets/STRIPE_SIGNING", { cookie: alice.cookie, ws: alice.ws, body: { value: STRIPE_SECRET } });
    const wf = await call("POST", "/api/workflows", {
      cookie: alice.cookie,
      ws: alice.ws,
      body: flow("Stripe", { type: "webhook", verify: { provider: "stripe", secret: "STRIPE_SIGNING" } }),
    });
    const key = wf.body.hookKey;
    const body = JSON.stringify({ type: "charge.succeeded" });
    const now = Math.floor(Date.now() / 1000);
    const sign = (t: number, secret = STRIPE_SECRET) => hmac(secret, `${t}.${body}`);

    expect((await hook(key, body)).status).toBe(401);
    expect((await hook(key, body, { "stripe-signature": `t=${now},v1=${sign(now, "wrong-secret")}` })).status).toBe(401);
    expect((await hook(key, body, { "stripe-signature": `t=${now - 400},v1=${sign(now - 400)}` })).status).toBe(401);
    expect((await hook(key, body, { "stripe-signature": `t=${now + 400},v1=${sign(now + 400)}` })).status).toBe(401);
    expect(await runsOf(wf.body.id)).toBe(0);
    expect(await runCount(alice.id)).toBe(0);

    expect((await hook(key, body, { "stripe-signature": `t=${now},v1=${sign(now)}` })).status).toBe(202);
    expect((await hook(key, body, { "stripe-signature": `t=${now - 60},v1=${sign(now - 60, "old-secret")},v1=${sign(now - 60)}` })).status).toBe(202);
    expect(await runsOf(wf.body.id)).toBe(2);
  });

  it("still takes unsigned calls on a webhook that doesn't check signatures", async () => {
    await freshRunBudget(alice.id);
    const wf = await call("POST", "/api/workflows", { cookie: alice.cookie, ws: alice.ws, body: flow("Plain", { type: "webhook" }) });
    expect((await hook(wf.body.hookKey, JSON.stringify({ a: 1 }))).status).toBe(202);
  });

  it("refuses a webhook whose signature secret names an invalid secret", async () => {
    const res = await call("POST", "/api/workflows", {
      cookie: alice.cookie,
      ws: alice.ws,
      body: flow("Bad verify", { type: "webhook", verify: { provider: "github", secret: "lowercase" } }),
    });
    expect(res.status).toBe(400);
  });

  // ---------- Run again ----------

  const echo = (prefix: string) => [{ id: "t", name: "T", type: "transform", retry, config: { output: `${prefix} {{ trigger.body.x }}` } }];

  it("runs a finished run again with the same input and the workflow's current steps", async () => {
    await freshRunBudget(alice.id);
    const wf = await call("POST", "/api/workflows", { cookie: alice.cookie, ws: alice.ws, body: flow("Again", { type: "manual" }, echo("v1")) });
    const first = await call("POST", `/api/workflows/${wf.body.id}/run`, { cookie: alice.cookie, ws: alice.ws, body: { input: { x: 7 } } });
    expect(first.status).toBe(202);
    const past = await call("GET", `/api/runs/${first.body.runId}`, { cookie: alice.cookie, ws: alice.ws });
    expect(past.body.status).toBe("succeeded");
    expect(past.body.logs[0].output).toBe("v1 7");

    const saved = await call("PUT", `/api/workflows/${wf.body.id}`, {
      cookie: alice.cookie,
      ws: alice.ws,
      body: { ...flow("Again", { type: "manual" }, echo("v2")), version: wf.body.version },
    });
    expect(saved.status).toBe(200);

    const again = await call("POST", `/api/runs/${first.body.runId}/rerun`, { cookie: alice.cookie, ws: alice.ws });
    expect(again.status).toBe(202);
    expect(again.body.runId).not.toBe(first.body.runId);
    const run = await call("GET", `/api/runs/${again.body.runId}`, { cookie: alice.cookie, ws: alice.ws });
    expect(run.body).toMatchObject({ status: "succeeded", rerunOf: first.body.runId, triggerType: "manual", workflowId: wf.body.id, input: past.body.input });
    expect(run.body.logs[0].output).toBe("v2 7");
    // The past run is unchanged and isn't marked as a rerun itself.
    const pastAfter = await call("GET", `/api/runs/${first.body.runId}`, { cookie: alice.cookie, ws: alice.ws });
    expect(pastAfter.body.rerunOf).toBeUndefined();
    expect(pastAfter.body.logs[0].output).toBe("v1 7");
  });

  it("keeps the trigger type of a webhook run it repeats", async () => {
    await freshRunBudget(alice.id);
    const wf = await call("POST", "/api/workflows", { cookie: alice.cookie, ws: alice.ws, body: flow("Hook again", { type: "webhook" }, echo("hook")) });
    const first = await hook(wf.body.hookKey, JSON.stringify({ x: 3 }));
    const again = await call("POST", `/api/runs/${first.body.runId}/rerun`, { cookie: alice.cookie, ws: alice.ws });
    expect(again.status).toBe(202);
    const run = await call("GET", `/api/runs/${again.body.runId}`, { cookie: alice.cookie, ws: alice.ws });
    expect(run.body).toMatchObject({ triggerType: "webhook", rerunOf: first.body.runId, status: "succeeded" });
    expect(run.body.logs[0].output).toBe("hook 3");
  });

  it("refuses to run again a run that hasn't finished, or whose input was removed", async () => {
    await freshRunBudget(alice.id);
    const steps = [{ id: "wait", name: "Wait", type: "delay", retry, config: { seconds: 3600 } }];
    const wf = await call("POST", "/api/workflows", { cookie: alice.cookie, ws: alice.ws, body: flow("Waits", { type: "manual" }, steps) });
    const waiting = await call("POST", `/api/workflows/${wf.body.id}/run`, { cookie: alice.cookie, ws: alice.ws, body: { input: {} } });
    expect((await call("GET", `/api/runs/${waiting.body.runId}`, { cookie: alice.cookie, ws: alice.ws })).body.status).toBe("waiting");
    expect((await call("POST", `/api/runs/${waiting.body.runId}/rerun`, { cookie: alice.cookie, ws: alice.ws })).status).toBe(409);

    // A finished run the storage guard emptied.
    await c.runs.updateOne({ _id: waiting.body.runId }, { $set: { status: "stopped", input: null, finishedAt: Date.now() } });
    expect((await call("POST", `/api/runs/${waiting.body.runId}/rerun`, { cookie: alice.cookie, ws: alice.ws })).status).toBe(409);
    expect(await runsOf(wf.body.id)).toBe(1);
  });

  it("doesn't run again another workspace's run", async () => {
    await freshRunBudget(alice.id);
    const wf = await call("POST", "/api/workflows", { cookie: alice.cookie, ws: alice.ws, body: flow("Private", { type: "manual" }, echo("p")) });
    const first = await call("POST", `/api/workflows/${wf.body.id}/run`, { cookie: alice.cookie, ws: alice.ws, body: { input: { x: 1 } } });
    expect((await call("POST", `/api/runs/${first.body.runId}/rerun`, { cookie: bob.cookie, ws: bob.ws })).status).toBe(404);
    expect((await call("POST", `/api/runs/${first.body.runId}/rerun`, { cookie: bob.cookie, ws: alice.ws })).status).toBe(404);
    expect(await runsOf(wf.body.id)).toBe(1);
  });

  it("says so when the past run's workflow has been deleted", async () => {
    await freshRunBudget(alice.id);
    const wf = await call("POST", "/api/workflows", { cookie: alice.cookie, ws: alice.ws, body: flow("Gone", { type: "manual" }, echo("g")) });
    const first = await call("POST", `/api/workflows/${wf.body.id}/run`, { cookie: alice.cookie, ws: alice.ws, body: { input: { x: 1 } } });
    // Deleting a workflow may delete its runs too; put the run back to see what running it again does.
    const kept = await c.runs.findOne({ _id: first.body.runId });
    expect((await call("DELETE", `/api/workflows/${wf.body.id}`, { cookie: alice.cookie, ws: alice.ws })).status).toBe(204);
    if (!(await c.runs.findOne({ _id: first.body.runId }))) await c.runs.insertOne(kept!);
    const res = await call("POST", `/api/runs/${first.body.runId}/rerun`, { cookie: alice.cookie, ws: alice.ws });
    expect(res.status).toBe(404);
    expect(await c.runs.countDocuments({ rerunOf: first.body.runId })).toBe(0);
  });

  it("counts a run started again against the hourly run budget, like a manual run", async () => {
    await freshRunBudget(alice.id);
    const wf = await call("POST", "/api/workflows", { cookie: alice.cookie, ws: alice.ws, body: flow("Budget", { type: "manual" }, echo("b")) });
    const first = await call("POST", `/api/workflows/${wf.body.id}/run`, { cookie: alice.cookie, ws: alice.ws, body: { input: { x: 1 } } });
    const before = (await call("GET", "/api/overview", { cookie: alice.cookie, ws: alice.ws })).body.runsThisHour;
    expect(before).toBe(1);
    expect((await call("POST", `/api/runs/${first.body.runId}/rerun`, { cookie: alice.cookie, ws: alice.ws })).status).toBe(202);
    expect((await call("GET", "/api/overview", { cookie: alice.cookie, ws: alice.ws })).body.runsThisHour).toBe(2);

    // A new account may start 10 an hour: at the limit, running again is refused and starts nothing.
    await c.counters.updateMany({ _id: { $regex: `^runs:${alice.id}:` } }, { $set: { n: LIMITS.newAccountRunsPerHour } });
    const refused = await call("POST", `/api/runs/${first.body.runId}/rerun`, { cookie: alice.cookie, ws: alice.ws });
    expect(refused.status).toBe(429);
    expect(await runsOf(wf.body.id)).toBe(2);
  });

  // ---------- Last ----------

  it("never sent a secret value back in any response", () => {
    const all = seen.join("\n");
    for (const value of [VALUE, `${VALUE}_v2`, GH_SECRET, STRIPE_SECRET, "cy-secret-value", "value-number-3", "a-replaced-value", "delete-me-please"]) {
      expect(all).not.toContain(value);
    }
  });
});
