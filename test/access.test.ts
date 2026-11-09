import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "../shared/limits";
import { apiKeyValid, newApiKey, newRecoveryCodes, normalizeRecoveryCode, recoveryCodeHash } from "../worker/auth";
import worker from "../worker/index";
import { type Collections, collections, ensureIndexes, type Env } from "../worker/mongo";
import { dropAll } from "./dropAll";
import { fakeMongo } from "./fakeMongo";

/**
 * Teams, recovery codes and API keys, end to end through the HTTP API: who can do what, and what
 * each role, link, code and key can't do.
 *
 * With MONGODB_TEST_URI set they run against that MongoDB (a throwaway database, dropped at the
 * end). Without it they run against the in-memory stand-in in fakeMongo.ts, so they are part of
 * plain `npm test`.
 */
const uri = process.env.MONGODB_TEST_URI;
const PEPPER = "test-pepper-0123456789abcdef";

describe("signed keys and recovery codes", () => {
  it("API keys carry a signature, so made-up ones are refused without a lookup", async () => {
    const key = await newApiKey(PEPPER);
    expect(key).toMatch(/^kw_[A-Za-z0-9_-]{40}$/);
    expect(await apiKeyValid(key, PEPPER)).toBe(true);
    expect(await apiKeyValid(key, "another-pepper-0123456789")).toBe(false);
    expect(await apiKeyValid(`kw_${"A".repeat(40)}`, PEPPER)).toBe(false);
    const flipped = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
    expect(await apiKeyValid(flipped, PEPPER)).toBe(false);
    expect(await apiKeyValid(key.slice(3), PEPPER)).toBe(false);
  });

  it("recovery codes are random, readable and hashed per account", async () => {
    const codes = newRecoveryCodes(8);
    expect(new Set(codes).size).toBe(8);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    // Typed in lowercase, without dashes, or with a look-alike letter: still the same code.
    expect(normalizeRecoveryCode("ab1d-efgh-jk0n")).toBe("AB1DEFGHJK0N");
    expect(normalizeRecoveryCode("ABLD EFGH JKON")).toBe("AB1DEFGHJK0N");
    const hash = await recoveryCodeHash(PEPPER, "usr_a", codes[0]);
    expect(hash).not.toContain(codes[0].replace(/-/g, ""));
    expect(await recoveryCodeHash(PEPPER, "usr_a", codes[0].toLowerCase().replace(/-/g, ""))).toBe(hash);
    // The same code under another account, or another pepper, is a different hash.
    expect(await recoveryCodeHash(PEPPER, "usr_b", codes[0])).not.toBe(hash);
    expect(await recoveryCodeHash("another-pepper-0123456789", "usr_a", codes[0])).not.toBe(hash);
  });
});

describe(`teams, recovery codes and API keys (${uri ? "MongoDB" : "in memory"})`, () => {
  const dbName = `knotwork_access_test_${Date.now()}`;
  const fake = uri ? null : fakeMongo();
  const env = (uri
    ? { MONGODB_URI: uri, MONGODB_DB: dbName, AUTH_PEPPER: PEPPER, ASSETS: {} }
    : { MONGODB_URI: "", AUTH_PEPPER: PEPPER, ASSETS: {}, SHARED_MONGO: fake }) as unknown as Env;
  let client: MongoClient | null = null;
  let raw: Collections;

  interface Options {
    body?: unknown;
    cookie?: string;
    ws?: string;
    key?: string;
    ip?: string;
    origin?: string;
  }

  /** One request through the Worker, waiting for its background work. */
  async function call(method: string, path: string, { body, cookie, ws, key, ip, origin = "http://kw.test" }: Options = {}) {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} };
    const headers = new Headers({ "content-type": "application/json" });
    if (origin) headers.set("origin", origin);
    if (cookie) headers.set("cookie", cookie);
    if (ws) headers.set("x-knotwork-workspace", ws);
    if (key) headers.set("authorization", `Bearer ${key}`);
    if (ip) headers.set("cf-connecting-ip", ip);
    const res = await worker.fetch(
      new Request(`http://kw.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
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

  interface Person {
    id: string;
    cookie: string;
    personal: string;
    email: string;
    password: string;
  }
  let n = 0;
  /** A new account. Each signs up from its own address, so the per-network limits don't mix them up. */
  async function person(name: string): Promise<Person> {
    n += 1;
    const email = `${name.toLowerCase()}${n}@example.com`;
    const password = `${name}-password-123`;
    const res = await call("POST", "/api/auth/signup", { body: { name, email, password }, ip: `198.51.100.${n}` });
    expect(res.status).toBe(200);
    return { id: res.body.user.id, cookie: res.cookie, personal: res.body.workspaces[0].id, email, password };
  }

  async function sharedWorkspace(owner: Person, name = "Team") {
    const ws = await call("POST", "/api/workspaces", { cookie: owner.cookie, body: { name } });
    expect(ws.status).toBe(201);
    return ws.body.id as string;
  }

  async function invite(owner: Person, ws: string, role: "editor" | "viewer") {
    const res = await call("POST", `/api/workspaces/${ws}/invites`, { cookie: owner.cookie, body: { role } });
    expect(res.status).toBe(201);
    return res.body as { id: string; token: string; role: string; uses: number; maxUses: number; expiresAt: number };
  }

  async function join(owner: Person, ws: string, who: Person, role: "editor" | "viewer") {
    const { id, token } = await invite(owner, ws, role);
    const res = await call("POST", `/api/invites/${token}/accept`, { cookie: who.cookie });
    expect(res.status).toBe(200);
    await call("DELETE", `/api/workspaces/${ws}/invites/${id}`, { cookie: owner.cookie });
  }

  let alice: Person;
  let bob: Person;
  let carol: Person;
  let mallory: Person;
  let team: string;

  beforeAll(async () => {
    if (uri) {
      client = await MongoClient.connect(uri);
      raw = collections(client.db(dbName));
      await ensureIndexes(raw);
    } else {
      raw = fake!.c;
    }
    alice = await person("Alice");
    bob = await person("Bob");
    carol = await person("Carol");
    mallory = await person("Mallory");
    team = await sharedWorkspace(alice);
  });

  afterAll(async () => {
    if (client) {
      await dropAll(client.db(dbName));
      await client.close();
    }
  });

  // ---------- Teams ----------

  describe("invite links", () => {
    it("only the owner makes them, never for a personal workspace, and the link isn't stored", async () => {
      const made = await invite(alice, team, "editor");
      expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(made).toMatchObject({ role: "editor", uses: 0, maxUses: LIMITS.inviteUses });
      expect(made.expiresAt).toBeGreaterThan(Date.now() + (LIMITS.inviteDays - 1) * 86_400_000);
      // Only a hash of the token is in the database.
      const stored = await raw.invites.find({}).toArray();
      expect(JSON.stringify(stored)).not.toContain(made.token);
      // The owner's list shows the link's details, not the link.
      const list = await call("GET", `/api/workspaces/${team}/team`, { cookie: alice.cookie });
      expect(list.body.invites).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain(made.token);

      expect((await call("POST", `/api/workspaces/${alice.personal}/invites`, { cookie: alice.cookie, body: { role: "editor" } })).status).toBe(409);
      // A stranger learns nothing about the workspace; a bad role is refused.
      expect((await call("POST", `/api/workspaces/${team}/invites`, { cookie: mallory.cookie, body: { role: "editor" } })).status).toBe(404);
      expect((await call("POST", `/api/workspaces/${team}/invites`, { cookie: alice.cookie, body: { role: "owner" } })).status).toBe(400);
      expect((await call("DELETE", `/api/workspaces/${team}/invites/${made.id}`, { cookie: mallory.cookie })).status).toBe(404);
      expect((await call("DELETE", `/api/workspaces/${team}/invites/${made.id}`, { cookie: alice.cookie })).status).toBe(204);
    });

    it("show what they offer, let someone in once, and never change a role someone already has", async () => {
      const made = await invite(alice, team, "editor");
      expect((await call("GET", `/api/invites/${made.token}`)).status).toBe(401);
      const preview = await call("GET", `/api/invites/${made.token}`, { cookie: bob.cookie });
      expect(preview.body).toEqual({ workspaceId: team, workspaceName: "Team", ownerName: "Alice", role: "editor", already: false });

      expect((await call("GET", "/api/workflows", { cookie: bob.cookie, ws: team })).status).toBe(404);
      const joined = await call("POST", `/api/invites/${made.token}/accept`, { cookie: bob.cookie });
      expect(joined.body).toEqual({ workspaceId: team });
      const me = await call("GET", "/api/me", { cookie: bob.cookie });
      expect(me.body.workspaces).toMatchObject([
        { name: "Personal", personal: true, role: "owner" },
        { id: team, name: "Team", personal: false, role: "editor" },
      ]);
      expect((await call("GET", "/api/workflows", { cookie: bob.cookie, ws: team })).status).toBe(200);

      // Joining again, or the owner opening their own link, changes nothing and uses nothing up.
      expect((await call("POST", `/api/invites/${made.token}/accept`, { cookie: bob.cookie })).status).toBe(200);
      expect((await call("POST", `/api/invites/${made.token}/accept`, { cookie: alice.cookie })).status).toBe(200);
      const viewerLink = await invite(alice, team, "viewer");
      expect((await call("POST", `/api/invites/${viewerLink.token}/accept`, { cookie: bob.cookie })).status).toBe(200);
      const list = await call("GET", `/api/workspaces/${team}/team`, { cookie: alice.cookie });
      expect(list.body.members.map((m: any) => [m.name, m.role])).toEqual([["Alice", "owner"], ["Bob", "editor"]]);
      expect(list.body.invites.map((i: any) => i.uses).sort()).toEqual([0, 1]);
      // Member lists carry names, never email addresses.
      expect(JSON.stringify(list.body)).not.toContain("@");
    });

    it("stop working when revoked, expired or used up", async () => {
      const ws = await sharedWorkspace(alice, "Links");
      const revoked = await invite(alice, ws, "viewer");
      await call("DELETE", `/api/workspaces/${ws}/invites/${revoked.id}`, { cookie: alice.cookie });
      expect((await call("GET", `/api/invites/${revoked.token}`, { cookie: carol.cookie })).status).toBe(404);
      expect((await call("POST", `/api/invites/${revoked.token}/accept`, { cookie: carol.cookie })).status).toBe(404);

      const expired = await invite(alice, ws, "viewer");
      await raw.invites.updateOne({ _id: expired.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await call("POST", `/api/invites/${expired.token}/accept`, { cookie: carol.cookie })).status).toBe(404);

      const used = await invite(alice, ws, "viewer");
      await raw.invites.updateOne({ _id: used.id }, { $set: { uses: LIMITS.inviteUses } });
      expect((await call("GET", `/api/invites/${used.token}`, { cookie: carol.cookie })).status).toBe(410);
      expect((await call("POST", `/api/invites/${used.token}/accept`, { cookie: carol.cookie })).status).toBe(410);

      // Made-up and malformed tokens.
      expect((await call("POST", `/api/invites/${"x".repeat(43)}/accept`, { cookie: carol.cookie })).status).toBe(404);
      expect((await call("POST", "/api/invites/short/accept", { cookie: carol.cookie })).status).toBe(404);
      expect((await call("GET", "/api/me", { cookie: carol.cookie })).body.workspaces).toHaveLength(1);
      await call("DELETE", `/api/workspaces/${ws}`, { cookie: alice.cookie });
    });

    it("one link lets in only as many people as it says, even when they click together", async () => {
      const ws = await sharedWorkspace(alice, "Rush");
      const made = await invite(alice, ws, "viewer");
      await raw.invites.updateOne({ _id: made.id }, { $set: { maxUses: 2 } });
      const people = await Promise.all(["P", "Q", "R", "S"].map(person));
      const results = await Promise.all(people.map((p) => call("POST", `/api/invites/${made.token}/accept`, { cookie: p.cookie })));
      expect(results.filter((r) => r.status === 200)).toHaveLength(2);
      expect(results.filter((r) => r.status === 410)).toHaveLength(2);
      expect(await raw.members.countDocuments({ workspaceId: ws })).toBe(2);
      await call("DELETE", `/api/workspaces/${ws}`, { cookie: alice.cookie });
    });

    it("can't be made or used by the shared demo account", async () => {
      const demo = await call("POST", "/api/auth/demo", { ip: "198.51.100.200" });
      const demoWs = demo.body.workspaces[0].id;
      const extra = await call("POST", "/api/workspaces", { cookie: demo.cookie, body: { name: "Demo side" } });
      expect((await call("POST", `/api/workspaces/${extra.body.id}/invites`, { cookie: demo.cookie, body: { role: "viewer" } })).status).toBe(403);
      const made = await invite(alice, team, "viewer");
      expect((await call("POST", `/api/invites/${made.token}/accept`, { cookie: demo.cookie })).status).toBe(403);
      expect((await call("POST", "/api/keys", { cookie: demo.cookie, body: { name: "k", workspaceId: demoWs, access: "read" } })).status).toBe(403);
      expect((await call("POST", "/api/auth/recovery-codes", { cookie: demo.cookie, body: { password: "x" } })).status).toBe(403);
      await call("DELETE", `/api/workspaces/${extra.body.id}`, { cookie: demo.cookie });
      await call("DELETE", `/api/workspaces/${team}/invites/${made.id}`, { cookie: alice.cookie });
    });
  });

  describe("roles", () => {
    let wf: { id: string; hookKey: string; version: number };

    beforeAll(async () => {
      const made = await call("POST", "/api/workflows", { cookie: alice.cookie, ws: team, body: flow("Shared hook", { type: "webhook" }) });
      wf = made.body;
      await join(alice, team, carol, "viewer");
    });

    it("an editor changes workflows and starts runs, charged to the owner", async () => {
      const made = await call("POST", "/api/workflows", { cookie: bob.cookie, ws: team, body: flow("Bob's") });
      expect(made.status).toBe(201);
      expect((await raw.workflows.findOne({ _id: made.body.id }))?.ownerId).toBe(alice.id);
      const saved = await call("PUT", `/api/workflows/${made.body.id}`, { cookie: bob.cookie, ws: team, body: { ...flow("Bob's v2"), version: 1 } });
      expect(saved.status).toBe(200);
      const run = await call("POST", `/api/workflows/${made.body.id}/run`, { cookie: bob.cookie, ws: team, body: { input: {} } });
      expect(run.status).toBe(202);
      expect((await raw.runs.findOne({ _id: run.body.runId }))?.ownerId).toBe(alice.id);
      // An editor sees the webhook URL, since they may start runs anyway.
      expect((await call("GET", `/api/workflows/${wf.id}`, { cookie: bob.cookie, ws: team })).body.hookKey).toBe(wf.hookKey);
      expect((await call("DELETE", `/api/workflows/${made.body.id}`, { cookie: bob.cookie, ws: team })).status).toBe(204);
    });

    it("an editor can't manage the workspace or its people", async () => {
      expect((await call("PATCH", `/api/workspaces/${team}`, { cookie: bob.cookie, body: { name: "Mine now" } })).status).toBe(404);
      expect((await call("DELETE", `/api/workspaces/${team}`, { cookie: bob.cookie })).status).toBe(404);
      expect((await call("POST", `/api/workspaces/${team}/invites`, { cookie: bob.cookie, body: { role: "editor" } })).status).toBe(403);
      expect((await call("PATCH", `/api/workspaces/${team}/members/${carol.id}`, { cookie: bob.cookie, body: { role: "editor" } })).status).toBe(403);
      expect((await call("PATCH", `/api/workspaces/${team}/members/${bob.id}`, { cookie: bob.cookie, body: { role: "editor" } })).status).toBe(403);
      expect((await call("DELETE", `/api/workspaces/${team}/members/${carol.id}`, { cookie: bob.cookie })).status).toBe(403);
      // Members see who is in the workspace, but not its invite links.
      const list = await call("GET", `/api/workspaces/${team}/team`, { cookie: bob.cookie });
      expect(list.body.members).toHaveLength(3);
      expect(list.body.invites).toEqual([]);
      expect((await call("GET", `/api/workspaces/${team}/team`, { cookie: mallory.cookie })).status).toBe(404);
    });

    it("a viewer reads everything except the webhook URL, and changes nothing", async () => {
      const as = { cookie: carol.cookie, ws: team };
      const list = await call("GET", "/api/workflows", as);
      expect(list.status).toBe(200);
      expect(list.body.map((w: any) => w.hookKey)).toEqual([""]);
      expect((await call("GET", `/api/workflows/${wf.id}`, as)).body.hookKey).toBe("");
      expect((await call("GET", "/api/overview", as)).body.workflows[0].hookKey).toBe("");
      expect((await call("GET", "/api/runs", as)).status).toBe(200);
      expect((await call("GET", `/api/locate/workflow/${wf.id}`, { cookie: carol.cookie })).body).toEqual({ workspaceId: team });

      expect((await call("POST", "/api/workflows", { ...as, body: flow("Nope") })).status).toBe(403);
      expect((await call("PUT", `/api/workflows/${wf.id}`, { ...as, body: { ...flow("Renamed"), version: wf.version } })).status).toBe(403);
      expect((await call("DELETE", `/api/workflows/${wf.id}`, as)).status).toBe(403);
      expect((await call("POST", `/api/workflows/${wf.id}/run`, { ...as, body: { input: {} } })).status).toBe(403);
      expect((await call("POST", "/api/runs/run_x/check", as)).status).toBe(403);
      expect((await call("PATCH", `/api/workspaces/${team}`, { cookie: carol.cookie, body: { name: "Mine now" } })).status).toBe(404);
      expect((await call("POST", `/api/workspaces/${team}/invites`, { cookie: carol.cookie, body: { role: "editor" } })).status).toBe(403);
      // Nothing changed.
      const after = await call("GET", `/api/workflows/${wf.id}`, { cookie: alice.cookie, ws: team });
      expect(after.body).toMatchObject({ name: "Shared hook", version: wf.version, hookKey: wf.hookKey });
      expect((await call("GET", "/api/me", { cookie: alice.cookie })).body.workspaces.find((w: any) => w.id === team).name).toBe("Team");
    });

    it("a role change or a removal takes effect on the very next request", async () => {
      const dave = await person("Dave");
      await join(alice, team, dave, "editor");
      const as = { cookie: dave.cookie, ws: team };
      expect((await call("POST", "/api/workflows", { ...as, body: flow("Dave's") })).status).toBe(201);
      expect((await call("PATCH", `/api/workspaces/${team}/members/${dave.id}`, { cookie: alice.cookie, body: { role: "viewer" } })).status).toBe(204);
      expect((await call("POST", "/api/workflows", { ...as, body: flow("Dave's 2") })).status).toBe(403);
      expect((await call("GET", "/api/workflows", as)).status).toBe(200);
      expect((await call("DELETE", `/api/workspaces/${team}/members/${dave.id}`, { cookie: alice.cookie })).status).toBe(204);
      expect((await call("GET", "/api/workflows", as)).status).toBe(404);
      expect((await call("GET", `/api/workspaces/${team}/team`, { cookie: dave.cookie })).status).toBe(404);
      expect((await call("GET", "/api/me", { cookie: dave.cookie })).body.workspaces).toHaveLength(1);
      expect((await call("DELETE", `/api/workspaces/${team}/members/${dave.id}`, { cookie: alice.cookie })).status).toBe(404);
    });

    it("a member can leave; the owner can't, and can't be removed", async () => {
      const erin = await person("Erin");
      await join(alice, team, erin, "viewer");
      expect((await call("DELETE", `/api/workspaces/${team}/members/${alice.id}`, { cookie: erin.cookie })).status).toBe(403);
      expect((await call("DELETE", `/api/workspaces/${team}/members/${alice.id}`, { cookie: alice.cookie })).status).toBe(409);
      expect((await call("DELETE", `/api/workspaces/${team}/members/${erin.id}`, { cookie: erin.cookie })).status).toBe(204);
      expect((await call("GET", "/api/workflows", { cookie: erin.cookie, ws: team })).status).toBe(404);
      // Leaving a workspace you were never in says nothing about it.
      expect((await call("DELETE", `/api/workspaces/${team}/members/${mallory.id}`, { cookie: mallory.cookie })).status).toBe(404);
    });

    it("a workspace header can't be bent into someone else's membership", async () => {
      for (const ws of [`${team}:${bob.id}`, `${team}:${alice.id}`, "", "ws_", `${team} `, "../" + team]) {
        expect((await call("GET", "/api/workflows", { cookie: mallory.cookie, ws })).status).toBe(404);
      }
    });

    it("holds at most the member limit", async () => {
      const ws = await sharedWorkspace(alice, "Crowd");
      const made = await invite(alice, ws, "viewer");
      await raw.invites.updateOne({ _id: made.id }, { $set: { maxUses: 100 } });
      const crowd = [];
      for (let i = 0; i < LIMITS.membersPerWorkspace + 1; i++) crowd.push(await person(`Crowd${i}`));
      const results = [];
      for (const p of crowd) results.push((await call("POST", `/api/invites/${made.token}/accept`, { cookie: p.cookie })).status);
      expect(results.filter((s) => s === 200)).toHaveLength(LIMITS.membersPerWorkspace);
      expect(results.at(-1)).toBe(409);
      expect(await raw.members.countDocuments({ workspaceId: ws })).toBe(LIMITS.membersPerWorkspace);
      // Deleting the workspace takes its members, links and keys with it.
      expect((await call("DELETE", `/api/workspaces/${ws}`, { cookie: alice.cookie })).status).toBe(204);
      expect(await raw.members.countDocuments({ workspaceId: ws })).toBe(0);
      expect(await raw.invites.countDocuments({ workspaceId: ws })).toBe(0);
      expect((await call("GET", "/api/me", { cookie: crowd[0].cookie })).body.workspaces).toHaveLength(1);
    });
  });

  // ---------- API keys ----------

  describe("API keys", () => {
    let writeKey: string;
    let readKey: string;
    let wfId: string;

    beforeAll(async () => {
      const w = await call("POST", "/api/keys", { cookie: alice.cookie, body: { name: "CI", workspaceId: team, access: "write" } });
      expect(w.status).toBe(201);
      writeKey = w.body.key;
      const r = await call("POST", "/api/keys", { cookie: alice.cookie, body: { name: "Dashboard", workspaceId: team, access: "read" } });
      readKey = r.body.key;
    });

    it("are shown once and stored only as a hash", async () => {
      expect(writeKey).toMatch(/^kw_[A-Za-z0-9_-]{40}$/);
      const list = await call("GET", "/api/keys", { cookie: alice.cookie });
      expect(list.body).toMatchObject([
        { name: "CI", workspaceId: team, access: "write", prefix: writeKey.slice(0, 9), lastUsedAt: null },
        { name: "Dashboard", workspaceId: team, access: "read" },
      ]);
      expect(JSON.stringify(list.body)).not.toContain(writeKey);
      const stored = JSON.stringify(await raw.apiKeys.find({}).toArray());
      expect(stored).not.toContain(writeKey);
      expect(stored).not.toContain(readKey);
      // Other accounts don't see them.
      expect((await call("GET", "/api/keys", { cookie: bob.cookie })).body).toEqual([]);
    });

    it("a write key works on workflows and runs in its own workspace, with no cookie or header", async () => {
      const made = await call("POST", "/api/workflows", { key: writeKey, origin: "", body: flow("From a script") });
      expect(made.status).toBe(201);
      wfId = made.body.id;
      expect(made.body.workspaceId).toBe(team);
      expect((await call("GET", "/api/workflows", { key: writeKey, origin: "" })).body.some((w: any) => w.id === wfId)).toBe(true);
      const run = await call("POST", `/api/workflows/${wfId}/run`, { key: writeKey, origin: "", body: { input: { n: 1 } } });
      expect(run.status).toBe(202);
      expect((await call("GET", `/api/runs/${run.body.runId}`, { key: writeKey, origin: "" })).status).toBe(200);
      expect((await call("GET", "/api/overview", { key: writeKey })).status).toBe(200);
      expect((await call("GET", "/api/keys", { cookie: alice.cookie })).body[0].lastUsedAt).toBeGreaterThan(0);
    });

    it("a read key reads, without webhook URLs, and can't change or run anything", async () => {
      const list = await call("GET", "/api/workflows", { key: readKey });
      expect(list.status).toBe(200);
      expect(list.body.every((w: any) => w.hookKey === "")).toBe(true);
      expect((await call("POST", "/api/workflows", { key: readKey, body: flow("Nope") })).status).toBe(403);
      expect((await call("DELETE", `/api/workflows/${wfId}`, { key: readKey })).status).toBe(403);
      expect((await call("POST", `/api/workflows/${wfId}/run`, { key: readKey, body: { input: {} } })).status).toBe(403);
    });

    it("never reaches accounts, teams, other keys or other workspaces", async () => {
      for (const [method, path] of [
        ["GET", "/api/me"],
        ["GET", "/api/keys"],
        ["POST", "/api/keys"],
        ["GET", "/api/workspaces"],
        ["POST", "/api/workspaces"],
        ["DELETE", `/api/workspaces/${team}`],
        ["GET", `/api/workspaces/${team}/team`],
        ["POST", `/api/workspaces/${team}/invites`],
        ["POST", "/api/auth/password"],
        ["POST", "/api/auth/recovery-codes"],
        ["POST", "/api/auth/delete-account"],
        ["GET", `/api/locate/workflow/${wfId}`],
        ["GET", "/api/workflowsx"],
      ] as const) {
        const res = await call(method, path, { key: writeKey, body: method === "GET" ? undefined : {} });
        expect([path, res.status]).toEqual([path, 403]);
      }
      // Naming another workspace (even the maker's own) is refused, not quietly ignored.
      expect((await call("GET", "/api/workflows", { key: writeKey, ws: alice.personal })).status).toBe(403);
      expect((await call("GET", "/api/workflows", { key: writeKey, ws: bob.personal })).status).toBe(403);
      expect((await call("GET", "/api/workflows", { key: writeKey, ws: team })).status).toBe(200);
    });

    it("a bad key is refused even when a good session cookie comes with it", async () => {
      const forged = `kw_${"A".repeat(40)}`;
      const unknown = await newApiKey(PEPPER);
      for (const key of [forged, unknown, "nonsense", writeKey.slice(0, -2), writeKey + "x"]) {
        expect((await call("GET", "/api/workflows", { key, cookie: alice.cookie, ws: team })).status).toBe(401);
      }
      // Another scheme, or an empty header, is not a key and not a session either.
      const res = await worker.fetch(
        new Request("http://kw.test/api/workflows", { headers: { authorization: "Basic abc", cookie: alice.cookie, "x-knotwork-workspace": team } }),
        env,
        { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
      );
      expect(res.status).toBe(401);
    });

    it("never has more rights than its maker has right now", async () => {
      const frank = await person("Frank");
      await join(alice, team, frank, "viewer");
      const refused = await call("POST", "/api/keys", { cookie: frank.cookie, body: { name: "W", workspaceId: team, access: "write" } });
      expect(refused.status).toBe(403);
      expect((await call("POST", "/api/keys", { cookie: frank.cookie, body: { name: "W", workspaceId: alice.personal, access: "read" } })).status).toBe(404);
      await call("PATCH", `/api/workspaces/${team}/members/${frank.id}`, { cookie: alice.cookie, body: { role: "editor" } });
      const made = await call("POST", "/api/keys", { cookie: frank.cookie, body: { name: "W", workspaceId: team, access: "write" } });
      expect(made.status).toBe(201);
      const key = made.body.key;
      const created = await call("POST", "/api/workflows", { key, body: flow("Frank's") });
      expect(created.status).toBe(201);
      expect((await raw.workflows.findOne({ _id: created.body.id }))?.ownerId).toBe(alice.id);
      // Made a viewer: the write key can only read from then on.
      await call("PATCH", `/api/workspaces/${team}/members/${frank.id}`, { cookie: alice.cookie, body: { role: "viewer" } });
      expect((await call("POST", "/api/workflows", { key, body: flow("Frank's 2") })).status).toBe(403);
      const seen = await call("GET", `/api/workflows/${created.body.id}`, { key });
      expect([seen.status, seen.body.hookKey]).toEqual([200, ""]);
      // Removed: the key is gone with the membership.
      await call("DELETE", `/api/workspaces/${team}/members/${frank.id}`, { cookie: alice.cookie });
      expect((await call("GET", "/api/workflows", { key })).status).toBe(401);
      expect((await call("GET", "/api/keys", { cookie: frank.cookie })).body).toEqual([]);
      await call("DELETE", `/api/workflows/${created.body.id}`, { cookie: alice.cookie, ws: team });
    });

    it("can be revoked by its maker only, and there is a limit per account", async () => {
      const list = (await call("GET", "/api/keys", { cookie: alice.cookie })).body;
      const read = list.find((k: any) => k.access === "read");
      expect((await call("DELETE", `/api/keys/${read.id}`, { cookie: bob.cookie })).status).toBe(404);
      expect((await call("GET", "/api/workflows", { key: readKey })).status).toBe(200);
      expect((await call("DELETE", `/api/keys/${read.id}`, { cookie: alice.cookie })).status).toBe(204);
      expect((await call("GET", "/api/workflows", { key: readKey })).status).toBe(401);

      const statuses = [];
      for (let i = 0; i < LIMITS.apiKeysPerAccount; i++) {
        statuses.push((await call("POST", "/api/keys", { cookie: alice.cookie, body: { name: `k${i}`, workspaceId: alice.personal, access: "read" } })).status);
      }
      expect(statuses.filter((s) => s === 201)).toHaveLength(LIMITS.apiKeysPerAccount - 1);
      expect(statuses.at(-1)).toBe(409);
      expect(await raw.apiKeys.countDocuments({ userId: alice.id })).toBe(LIMITS.apiKeysPerAccount);
    });
  });

  // ---------- Recovery codes ----------

  describe("recovery codes", () => {
    let gina: Person;
    let codes: string[];
    const recover = (email: string, code: string, password: string, ip = "198.51.100.250") =>
      call("POST", "/api/auth/recover", { body: { email, code, password }, ip });

    beforeAll(async () => {
      gina = await person("Gina");
    });

    it("are made with the password, shown once, and stored only as hashes", async () => {
      expect((await call("GET", "/api/me", { cookie: gina.cookie })).body.recoveryCodesLeft).toBe(0);
      expect((await call("POST", "/api/auth/recovery-codes", { cookie: gina.cookie, body: { password: "wrong-password-1" } })).status).toBe(403);
      expect((await call("POST", "/api/auth/recovery-codes", { body: { password: gina.password } })).status).toBe(401);
      const made = await call("POST", "/api/auth/recovery-codes", { cookie: gina.cookie, body: { password: gina.password } });
      expect(made.status).toBe(200);
      codes = made.body.codes;
      expect(codes).toHaveLength(LIMITS.recoveryCodes);
      expect((await call("GET", "/api/me", { cookie: gina.cookie })).body.recoveryCodesLeft).toBe(LIMITS.recoveryCodes);
      const stored = JSON.stringify(await raw.users.findOne({ _id: gina.id }));
      for (const code of codes) {
        expect(stored).not.toContain(code);
        expect(stored).not.toContain(code.replace(/-/g, ""));
      }
      expect(JSON.stringify((await call("GET", "/api/me", { cookie: gina.cookie })).body)).not.toContain("recoveryCodes\"");
    });

    it("a wrong code, an unknown email and someone else's code all get the same answer", async () => {
      const wrong = await recover(gina.email, "AAAA-BBBB-CCCC", "new-password-123");
      const unknown = await recover("nobody@example.com", codes[0], "new-password-123");
      expect([wrong.status, unknown.status]).toEqual([401, 401]);
      expect(wrong.body).toEqual(unknown.body);
      // Bob's account can't be opened with Gina's code.
      expect((await recover(bob.email, codes[0], "new-password-123")).status).toBe(401);
      expect((await recover(gina.email, "not a code", "new-password-123")).status).toBe(400);
      expect((await recover(gina.email, codes[0], "short")).status).toBe(400);
      // None of that used a code up or changed the password.
      expect((await call("GET", "/api/me", { cookie: gina.cookie })).body.recoveryCodesLeft).toBe(LIMITS.recoveryCodes);
      expect((await call("POST", "/api/auth/login", { body: { email: gina.email, password: gina.password }, ip: "198.51.100.251" })).status).toBe(200);
    });

    it("the right code sets a new password, signs out every device, and works once", async () => {
      const typed = codes[0].toLowerCase().replace(/-/g, " ");
      const ok = await recover(gina.email.toUpperCase(), typed, "gina-new-password-1");
      expect(ok.status).toBe(200);
      expect(ok.body.user.id).toBe(gina.id);
      expect(ok.body.recoveryCodesLeft).toBe(LIMITS.recoveryCodes - 1);
      expect(ok.cookie).toMatch(/^kw_session=/);
      expect((await call("GET", "/api/me", { cookie: gina.cookie })).status).toBe(401);
      expect((await call("GET", "/api/me", { cookie: ok.cookie })).status).toBe(200);
      const login = (password: string) => call("POST", "/api/auth/login", { body: { email: gina.email, password }, ip: "198.51.100.252" });
      expect((await login(gina.password)).status).toBe(401);
      expect((await login("gina-new-password-1")).status).toBe(200);
      expect((await recover(gina.email, codes[0], "attacker-password-1")).status).toBe(401);
      expect((await login("gina-new-password-1")).status).toBe(200);
      gina = { ...gina, cookie: ok.cookie, password: "gina-new-password-1" };
    });

    it("recovering or changing the password revokes the account's API keys", async () => {
      const make = async () => (await call("POST", "/api/keys", { cookie: gina.cookie, body: { name: "k", workspaceId: gina.personal, access: "write" } })).body.key;
      const first = await make();
      expect((await call("GET", "/api/workflows", { key: first })).status).toBe(200);
      const changed = await call("POST", "/api/auth/password", { cookie: gina.cookie, body: { current: gina.password, next: "gina-changed-password" } });
      expect(changed.status).toBe(204);
      gina = { ...gina, password: "gina-changed-password" };
      expect((await call("GET", "/api/workflows", { key: first })).status).toBe(401);
      const second = await make();
      const ok = await recover(gina.email, codes[3], "gina-recovered-again");
      expect(ok.status).toBe(200);
      gina = { ...gina, cookie: ok.cookie, password: "gina-recovered-again" };
      expect((await call("GET", "/api/workflows", { key: second })).status).toBe(401);
    });

    it("one code used twice at the same moment works once", async () => {
      const results = await Promise.all([
        recover(gina.email, codes[1], "race-password-aaa", "198.51.100.253"),
        recover(gina.email, codes[1], "race-password-bbb", "198.51.100.254"),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
      const winner = results.find((r) => r.status === 200)!;
      gina = { ...gina, cookie: winner.cookie, password: results[0].status === 200 ? "race-password-aaa" : "race-password-bbb" };
      expect((await call("GET", "/api/me", { cookie: gina.cookie })).body.recoveryCodesLeft).toBe(LIMITS.recoveryCodes - 3);
    });

    it("making new codes ends the old ones", async () => {
      const made = await call("POST", "/api/auth/recovery-codes", { cookie: gina.cookie, body: { password: gina.password } });
      expect(made.status).toBe(200);
      expect((await recover(gina.email, codes[2], "another-password-1")).status).toBe(401);
      expect(made.body.codes).not.toContain(codes[2]);
      codes = made.body.codes;
    });

    it("guessing is cut off, per email and address", async () => {
      const statuses = [];
      for (let i = 0; i < LIMITS.loginAttemptsPer15Min + 1; i++) {
        statuses.push((await recover(gina.email, "AAAA-BBBB-CCCC", "guess-password-1", "203.0.113.77")).status);
      }
      expect(statuses.slice(0, LIMITS.loginAttemptsPer15Min).every((s) => s === 401)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
      // Even the right code is refused from there while the pause lasts; from Gina's own address it works.
      expect((await recover(gina.email, codes[0], "guess-password-1", "203.0.113.77")).status).toBe(429);
      expect((await recover(gina.email, codes[0], "gina-final-password", "203.0.113.78")).status).toBe(200);
    });
  });

  // ---------- Deleting an account ----------

  it("deleting an account removes its memberships and keys, and its workspaces' members, links and keys", async () => {
    const owner = await person("Olga");
    const guest = await person("Guy");
    const ws = await sharedWorkspace(owner, "Olga's team");
    await join(owner, ws, guest, "editor");
    await invite(owner, ws, "viewer");
    const guestKey = await call("POST", "/api/keys", { cookie: guest.cookie, body: { name: "g", workspaceId: ws, access: "write" } });
    await join(alice, team, owner, "editor");
    const ownerKey = await call("POST", "/api/keys", { cookie: owner.cookie, body: { name: "o", workspaceId: team, access: "write" } });
    expect((await call("GET", "/api/workflows", { key: guestKey.body.key })).status).toBe(200);

    expect((await call("POST", "/api/auth/delete-account", { cookie: owner.cookie, body: { password: owner.password } })).status).toBe(204);
    expect((await call("GET", "/api/workflows", { key: guestKey.body.key })).status).toBe(401);
    expect((await call("GET", "/api/workflows", { key: ownerKey.body.key })).status).toBe(401);
    expect((await call("GET", "/api/workflows", { cookie: guest.cookie, ws })).status).toBe(404);
    expect((await call("GET", "/api/me", { cookie: guest.cookie })).body.workspaces).toHaveLength(1);
    expect(await raw.members.countDocuments({ $or: [{ userId: owner.id }, { ownerId: owner.id }] })).toBe(0);
    expect(await raw.invites.countDocuments({ ownerId: owner.id })).toBe(0);
    expect(await raw.apiKeys.countDocuments({ $or: [{ userId: owner.id }, { ownerId: owner.id }] })).toBe(0);
    const list = await call("GET", `/api/workspaces/${team}/team`, { cookie: alice.cookie });
    expect(list.body.members.some((m: any) => m.userId === owner.id)).toBe(false);
  });
});
