import { type Db, MongoClient } from "mongodb";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { findTemplate } from "../shared/templates";
import { newHookKey } from "../worker/auth";
import { insertWorkflow } from "../worker/db";
import { advance, createRun } from "../worker/engine";
import { type Collections, collections, type RunDoc } from "../worker/mongo";
import { putSecret } from "../worker/secrets";
import { dropAll } from "./dropAll";

/**
 * The "New GitHub star to Discord" template run by the engine with a stored secret and a stubbed
 * Discord (MONGODB_TEST_URI): the webhook URL is read from the secret, the request goes to Discord,
 * and the URL never shows up in what the run stores.
 */
const uri = process.env.MONGODB_TEST_URI;
const PEPPER = "test-pepper-0123456789abcdef";
const HOOK = "https://discord.com/api/webhooks/987654321/SECRETpartOFtheHOOK_abc";

describe.skipIf(!uri)("ready-made steps in the engine", () => {
  let client: MongoClient;
  let db: Db;
  let c: Collections;

  beforeAll(async () => {
    client = await MongoClient.connect(uri!);
    db = client.db(`knotwork_connectors_test_${Date.now()}`);
    c = collections(db);
  });
  afterAll(async () => {
    if (db) await dropAll(db);
    await client?.close();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function startTemplate(ws: string, owner: string, input: unknown) {
    await c.workspaces.updateOne({ _id: ws }, { $setOnInsert: { ownerId: owner, name: ws, personal: false, createdAt: 1 } }, { upsert: true });
    const wf = await insertWorkflow(c, ws, owner, findTemplate("github-star-to-discord")!.workflow, Date.now(), await newHookKey(PEPPER));
    if (typeof wf === "string") throw new Error(wf);
    return createRun(c, { ...wf, ownerId: owner }, "webhook", input);
  }
  const star = { body: { action: "created", sender: { login: "ada" }, repository: { full_name: "o/r", stargazers_count: 7 } } };

  it("posts a new star to Discord with the webhook from the secret, and stores no trace of it", async () => {
    await c.workspaces.updateOne({ _id: "ws_c1" }, { $setOnInsert: { ownerId: "usr_c1", name: "c1", personal: false, createdAt: 1 } }, { upsert: true });
    expect(await putSecret(c, PEPPER, "ws_c1", "usr_c1", "DISCORD_WEBHOOK", HOOK, Date.now())).toMatchObject({ name: "DISCORD_WEBHOOK" });
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ id: "m9", channel_id: "c9" }), { headers: { "content-type": "application/json" } });
    });
    const runId = await startTemplate("ws_c1", "usr_c1", star);
    await advance(c, runId, PEPPER);
    const run = (await c.runs.findOne({ _id: runId })) as RunDoc;
    expect(run.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${HOOK}?wait=true`);
    expect(calls[0].body).toMatchObject({ content: "⭐ ada starred o/r, now at 7 stars", username: "Knotwork" });
    expect(run.outputs.discord).toMatchObject({ messageId: "m9" });
    expect(JSON.stringify(run)).not.toContain("SECRETpartOFtheHOOK");
  });

  it("fails before calling anything when the secret is missing, naming it", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const runId = await startTemplate("ws_c2", "usr_c2", star);
    await advance(c, runId, PEPPER);
    const run = (await c.runs.findOne({ _id: runId })) as RunDoc;
    // The template retries the Discord step, so the run waits for its next try; the log says why.
    expect(run.status).toBe("waiting");
    expect(JSON.stringify(run.logs.at(-1))).toMatch(/secret DISCORD_WEBHOOK isn't set/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a filtered-out event never reaches Discord", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const runId = await startTemplate("ws_c3", "usr_c3", { body: { action: "deleted" } });
    await advance(c, runId, PEPPER);
    expect(((await c.runs.findOne({ _id: runId })) as RunDoc).status).toBe("stopped");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
