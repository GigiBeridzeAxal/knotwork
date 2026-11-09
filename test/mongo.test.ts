import { type Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkflowInput } from "../shared/schema";
import { deleteWorkspace, getRun, insertWorkflow, runBlocked, updateWorkflow } from "../worker/db";
import { advance, createRun, tick } from "../worker/engine";
import { type Collections, collections } from "../worker/mongo";

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

  beforeAll(async () => {
    client = await MongoClient.connect(uri!);
    db = client.db(`knotwork_test_${Date.now()}`);
    c = collections(db);
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await client?.close();
  });

  const wfInput = (steps: WorkflowInput["steps"]): WorkflowInput => ({ name: "Test", description: "", enabled: true, trigger: { type: "manual" }, steps });
  const transform = (id: string, output: unknown) => ({ id, name: id, type: "transform" as const, retry: { max: 0, backoffSeconds: 5 }, config: { output } });

  async function start(steps: WorkflowInput["steps"], owner = "usr_a", ws = "ws_a") {
    const wf = await insertWorkflow(c, ws, owner, wfInput(steps), Date.now());
    const runId = await createRun(c, { ...wf, ownerId: owner }, "manual", { body: { n: 1 } });
    return { wf, runId };
  }

  it("runs a workflow to the end and records the last run on the workflow", async () => {
    const { wf, runId } = await start([transform("a", { n: "{{ trigger.body.n }}" }), transform("b", "{{ steps.a.n }}")]);
    await advance(c, runId);
    const run = await getRun(c, runId, "ws_a");
    expect(run?.status).toBe("succeeded");
    expect(run?.logs.map((l) => l.output)).toEqual([{ n: 1 }, 1]);
    expect((await c.workflows.findOne({ _id: wf.id }))?.lastRun?.status).toBe("succeeded");
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
    const wf = await insertWorkflow(c, "ws_a", "usr_a", wfInput([]), Date.now());
    const first = await updateWorkflow(c, wf.id, "ws_a", { ...wfInput([]), name: "Tab one" }, 1, Date.now());
    expect(first.ok).toBe(true);
    const second = await updateWorkflow(c, wf.id, "ws_a", { ...wfInput([]), name: "Tab two" }, 1, Date.now());
    expect(second).toMatchObject({ ok: false, reason: "stale", current: { name: "Tab one", version: 2 } });
    expect((await updateWorkflow(c, wf.id, "ws_other", wfInput([]), 2, Date.now())).ok).toBe(false);
  });

  it("counts runs per account for the hourly limit", async () => {
    const now = Date.now();
    await c.runs.insertMany(
      Array.from({ length: 60 }, (_, i) => ({ _id: `run_limit_${i}`, ownerId: "usr_busy", createdAt: now - 1000 }) as never),
    );
    expect(await runBlocked(c, "usr_busy", now)).toMatch(/60 runs/);
    expect(await runBlocked(c, "usr_quiet", now)).toBeNull();
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
