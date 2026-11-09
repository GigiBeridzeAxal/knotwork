import { type Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkflowInput } from "../shared/schema";
import type { Workflow } from "../shared/schema";
import { deleteWorkspace, getRun, insertWorkflow, takeRunSlot, updateWorkflow } from "../worker/db";
import { ensureDemo } from "../worker/demo";
import { advance, createRun, tick } from "../worker/engine";
import { type Collections, collections } from "../worker/mongo";
import { dropAll } from "./dropAll";

/**
 * Database tests. They need a MongoDB to talk to, so they only run when MONGODB_TEST_URI is set,
 * e.g. `MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test` with a local `mongod`. Each run uses
 * a fresh database and drops it at the end.
 */
const uri = process.env.MONGODB_TEST_URI;

describe.skipIf(!uri)("engine and data on MongoDB", () => {
  let client: MongoClient;
  let db: Db;
  let c: Collections;
  let ferret = false;

  beforeAll(async () => {
    client = await MongoClient.connect(uri!);
    db = client.db(`knotwork_test_${Date.now()}`);
    c = collections(db);
    ferret = "ferretdbVersion" in (await db.admin().command({ buildInfo: 1 }));
  });

  afterAll(async () => {
    if (db) await dropAll(db);
    await client?.close();
  });

  const wfInput = (steps: WorkflowInput["steps"]): WorkflowInput => ({ name: "Test", description: "", enabled: true, trigger: { type: "manual" }, steps });
  const transform = (id: string, output: unknown) => ({ id, name: id, type: "transform" as const, retry: { max: 0, backoffSeconds: 5 }, config: { output } });

  async function workspace(id: string, ownerId: string) {
    await c.workspaces.updateOne({ _id: id }, { $setOnInsert: { ownerId, name: id, personal: false, createdAt: 1 } }, { upsert: true });
  }

  async function addWorkflow(ws: string, owner: string, input: WorkflowInput): Promise<Workflow> {
    await workspace(ws, owner);
    const wf = await insertWorkflow(c, ws, owner, input, Date.now());
    if (typeof wf === "string") throw new Error(`insert refused: ${wf}`);
    return wf;
  }

  async function start(steps: WorkflowInput["steps"], owner = "usr_a", ws = "ws_a") {
    const wf = await addWorkflow(ws, owner, wfInput(steps));
    const runId = await createRun(c, { ...wf, ownerId: owner }, "manual", { body: { n: 1 } });
    return { wf, runId };
  }

  it("runs a workflow to the end and records the last run on the workflow", async () => {
    const { wf, runId } = await start([transform("a", { n: "{{ trigger.body.n }}" }), transform("b", "{{ steps.a.n }}")]);
    await advance(c, runId);
    const run = await getRun(c, runId, "ws_a");
    expect(run?.status).toBe("succeeded");
    expect(run?.logs.map((l) => l.output)).toEqual([{ n: 1 }, 1]);
    expect(run?.input).toEqual({ body: { n: 1 } });
    expect((await c.workflows.findOne({ _id: wf.id }))?.lastRun?.status).toBe("succeeded");
  });

  it("shows a parked run as waiting on its workflow and keeps it until after it wakes", async () => {
    const delay = { id: "d", name: "Wait", type: "delay" as const, retry: { max: 0, backoffSeconds: 5 }, config: { seconds: 6 * 86_400 } };
    const { wf, runId } = await start([delay, transform("a", 1)]);
    await advance(c, runId);
    const run = await c.runs.findOne({ _id: runId });
    expect(run?.status).toBe("waiting");
    expect(run!.expiresAt.getTime()).toBeGreaterThan(run!.nextRunAt! + 6 * 86_400_000);
    expect((await c.workflows.findOne({ _id: wf.id }))?.lastRun?.status).toBe("waiting");
  });

  it("keeps only a short preview of each output in the log", async () => {
    const { runId } = await start([transform("a", "x".repeat(5_000))]);
    await advance(c, runId);
    const run = await c.runs.findOne({ _id: runId });
    expect(run?.outputs.a).toHaveLength(5_000);
    expect(run?.logs[0].output).toMatchObject({ truncated: true });
  });

  it("survives a step whose output contains the run's own context", async () => {
    const { runId } = await start([transform("a", "{{ steps }}"), transform("b", "{{ steps }}"), transform("c", "done")]);
    await advance(c, runId);
    expect((await getRun(c, runId, "ws_a"))?.status).toBe("succeeded");
  });

  it("keeps ticking when one run is broken", async () => {
    const { runId: good } = await start([transform("a", 1)]);
    // A run whose stored steps are garbage: advancing it throws inside the engine.
    const { runId: bad } = await start([transform("a", 1)]);
    await c.runs.updateOne({ _id: bad }, { $set: { steps: null as never } });
    await expect(tick(c)).resolves.toBeTruthy();
    expect((await c.runs.findOne({ _id: good }))?.status).toBe("succeeded");
    expect((await c.runs.findOne({ _id: bad }))?.status).toBe("failed");
  });

  it("gives up on a run that keeps getting claimed without progress", async () => {
    const { runId } = await start([transform("a", 1)]);
    await c.runs.updateOne({ _id: runId }, { $set: { status: "running", leaseUntil: 0, claims: 3 } });
    await advance(c, runId);
    const run = await c.runs.findOne({ _id: runId });
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/stopped making progress/);
  });

  it("refuses a save made from an old version", async () => {
    const wf = await addWorkflow("ws_a", "usr_a", wfInput([]));
    const first = await updateWorkflow(c, wf.id, "ws_a", { ...wfInput([]), name: "Tab one" }, 1, Date.now());
    expect(first.ok).toBe(true);
    const second = await updateWorkflow(c, wf.id, "ws_a", { ...wfInput([]), name: "Tab two" }, 1, Date.now());
    expect(second).toMatchObject({ ok: false, reason: "stale", current: { name: "Tab one", version: 2 } });
    expect((await updateWorkflow(c, wf.id, "ws_other", wfInput([]), 2, Date.now())).ok).toBe(false);
  });

  /** A user document, as the run budget looks up the account's age. */
  async function account(id: string, ageMs = 2 * 86_400_000) {
    await c.users.insertOne({ _id: id, name: id, email: `${id}@example.com`, password: null, demo: false, createdAt: Date.now() - ageMs });
  }

  it("counts runs per account for the hourly limit", async () => {
    await Promise.all([account("usr_busy"), account("usr_quiet")]);
    const now = Date.now();
    const results = [];
    for (let i = 0; i < 61; i++) results.push(await takeRunSlot(c, "usr_busy", now));
    expect(results.filter((r) => r === null)).toHaveLength(60);
    expect(results[60]).toMatch(/60 runs/);
    expect(await takeRunSlot(c, "usr_quiet", now)).toBeNull();
  });

  it("doesn't let runs started at the same moment get past the limit", async (ctx) => {
    // FerretDB (a stand-in for local testing) doesn't apply parallel $inc atomically; MongoDB does.
    if (ferret) ctx.skip();
    await account("usr_rush");
    const now = Date.now();
    const results = await Promise.all(Array.from({ length: 70 }, () => takeRunSlot(c, "usr_rush", now)));
    expect(results.filter((r) => r === null)).toHaveLength(60);
  });

  it("gives a new account a smaller budget, and a deleted account's workflows none", async () => {
    await account("usr_new", 3_600_000);
    const now = Date.now();
    const results = [];
    for (let i = 0; i < 11; i++) results.push(await takeRunSlot(c, "usr_new", now));
    expect(results.filter((r) => r === null)).toHaveLength(10);
    expect(results[10]).toMatch(/first day/);
    expect(await takeRunSlot(c, "usr_gone", now, "webhook")).toMatch(/deleted/);
  });

  it("shares the cron's slots between accounts, in the order runs became ready", async () => {
    const now = Date.now();
    // 30 runs of one busy account that have been ready for a while, then one run of another account.
    const hog = await addWorkflow("ws_hog", "usr_hog", wfInput([transform("a", 1)]));
    for (let i = 0; i < 30; i++) {
      const runId = await createRun(c, { ...hog, ownerId: "usr_hog" }, "manual", {});
      await c.runs.updateOne({ _id: runId }, { $set: { nextRunAt: now - 60_000 + i } });
    }
    const { runId: other } = await start([transform("a", 1)], "usr_other", "ws_other");
    await tick(c, now + 1_000);
    expect((await c.runs.findOne({ _id: other }))?.status).toBe("succeeded");
    expect(await c.runs.countDocuments({ ownerId: "usr_hog", status: "succeeded" })).toBe(2);
  });

  it("never lets parallel saves put more workflows in a workspace than the limit", async () => {
    await workspace("ws_full", "usr_f");
    const results = await Promise.all(Array.from({ length: 14 }, () => insertWorkflow(c, "ws_full", "usr_f", wfInput([]), Date.now())));
    expect(results.filter((r) => typeof r !== "string").length).toBeLessThanOrEqual(10);
    expect(await c.workflows.countDocuments({ workspaceId: "ws_full" })).toBeLessThanOrEqual(10);
    expect(await insertWorkflow(c, "ws_missing", "usr_f", wfInput([]), Date.now())).toBe("gone");
  });

  it("seeds the demo account once, even when many people open it at the same moment", async () => {
    await Promise.all(Array.from({ length: 5 }, () => ensureDemo(c, Date.now())));
    expect(await c.workflows.countDocuments({ ownerId: "usr_demo" })).toBe(3);
  });

  it("deletes a workspace with its workflows and runs, but never the personal one", async () => {
    await c.workspaces.insertMany([
      { _id: "ws_p", ownerId: "usr_d", name: "Personal", personal: true, createdAt: 1 },
      { _id: "ws_x", ownerId: "usr_d", name: "Side", personal: false, createdAt: 2 },
    ]);
    const { runId } = await start([transform("a", 1)], "usr_d", "ws_x");
    expect(await deleteWorkspace(c, "ws_p", "usr_d")).toBe(false);
    expect(await deleteWorkspace(c, "ws_x", "usr_other")).toBe(false);
    expect(await deleteWorkspace(c, "ws_x", "usr_d")).toBe(true);
    expect(await c.workflows.countDocuments({ workspaceId: "ws_x" })).toBe(0);
    expect(await c.runs.findOne({ _id: runId })).toBeNull();
  });
});
