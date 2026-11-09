import { type Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkflowInput } from "../shared/schema";
import type { Workflow } from "../shared/schema";
import { deleteWorkspace, getRun, insertWorkflow, takeRunSlot, updateWorkflow } from "../worker/db";
import { ensureDemo } from "../worker/demo";
import { advance, createRun, guardStorage, tick } from "../worker/engine";
import { bump } from "../worker/auth";
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

  it("past half of the shared ceiling, holds back busy accounts' on-demand runs until the hour turns", async () => {
    await Promise.all([account("usr_fair_busy"), account("usr_fair_quiet")]);
    const now = Date.now();
    await bump(c, "runs:all", 3_600_000, now, 1_500);
    const results = [];
    for (let i = 0; i < 21; i++) results.push(await takeRunSlot(c, "usr_fair_busy", now, "webhook"));
    expect(results.filter((r) => r === null)).toHaveLength(20);
    const next = new Date((Math.floor(now / 3_600_000) + 1) * 3_600_000).toISOString().slice(11, 16);
    expect(results[20]).toContain(`${next} UTC`);
    expect(await takeRunSlot(c, "usr_fair_busy", now, "schedule")).toBeNull();
    expect(await takeRunSlot(c, "usr_fair_quiet", now, "webhook")).toBeNull();
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
    // 60 runs of one busy account that have been ready for a while (more than one query's window),
    // then one run of another account.
    const hog = await addWorkflow("ws_hog", "usr_hog", wfInput([transform("a", 1)]));
    for (let i = 0; i < 60; i++) {
      const runId = await createRun(c, { ...hog, ownerId: "usr_hog" }, "manual", {});
      await c.runs.updateOne({ _id: runId }, { $set: { nextRunAt: now - 60_000 + i } });
    }
    const { runId: other } = await start([transform("a", 1)], "usr_other", "ws_other");
    await tick(c, now + 1_000);
    expect((await c.runs.findOne({ _id: other }))?.status).toBe("succeeded");
    // The other account's run goes first; slots nobody else needs go to the busy account.
    expect(await c.runs.countDocuments({ ownerId: "usr_hog", status: "succeeded" })).toBe(9);
  });

  it("lets accounts take turns, so five busy accounts ahead don't hold a quiet one back", async () => {
    await c.runs.deleteMany({ status: { $in: ["queued", "waiting"] } }); // the last test's backlog
    const now = Date.now();
    for (const owner of ["usr_b1", "usr_b2", "usr_b3", "usr_b4", "usr_b5"]) {
      const wf = await addWorkflow(`ws_${owner}`, owner, wfInput([transform("a", 1)]));
      for (let i = 0; i < 25; i++) {
        const runId = await createRun(c, { ...wf, ownerId: owner }, "manual", {});
        await c.runs.updateOne({ _id: runId }, { $set: { nextRunAt: now - 60_000 + i } });
      }
    }
    const { runId: quiet } = await start([transform("a", 1)], "usr_q", "ws_q");
    // The first tick serves five accounts (the quiet one among the least served); every account is
    // reached within two ticks.
    await tick(c, now + 1_000);
    await tick(c, now + 61_000);
    expect((await c.runs.findOne({ _id: quiet }))?.status).toBe("succeeded");
    for (const owner of ["usr_b1", "usr_b2", "usr_b3", "usr_b4", "usr_b5"]) {
      expect(await c.runs.countDocuments({ ownerId: owner, status: "succeeded" })).toBeGreaterThanOrEqual(1);
    }
    // A newcomer with one ready run is served on the very next tick, ahead of accounts already served.
    const { runId: late } = await start([transform("a", 1)], "usr_late", "ws_late");
    await tick(c, now + 121_000);
    expect((await c.runs.findOne({ _id: late }))?.status).toBe("succeeded");
  });

  it("stops the biggest backlogs when the database is nearly full", async () => {
    await c.runs.deleteMany({ status: { $in: ["queued", "waiting"] } });
    const wf = await addWorkflow("ws_heap", "usr_heap", wfInput([transform("a", 1)]));
    const heap = [];
    for (let i = 0; i < 5; i++) heap.push(await createRun(c, { ...wf, ownerId: "usr_heap" }, "manual", {}));
    for (const [owner, n] of [["usr_m1", 3], ["usr_m2", 2]] as const) {
      const other = await addWorkflow(`ws_${owner}`, owner, wfInput([transform("a", 1)]));
      for (let i = 0; i < n; i++) await createRun(c, { ...other, ownerId: owner }, "manual", {});
    }
    const { runId: small } = await start([transform("a", 1)], "usr_small", "ws_small");
    const nearlyFull = { stats: async () => ({ dataSize: 400_000_000, indexSize: 0 }) } as unknown as Db;
    await guardStorage(c, nearlyFull, Date.now());
    expect(await c.runs.countDocuments({ _id: { $in: heap }, status: "stopped" })).toBe(5);
    // Only the three biggest backlogs are stopped.
    expect(await c.runs.countDocuments({ ownerId: { $in: ["usr_m1", "usr_m2"] }, status: "stopped" })).toBe(5);
    expect((await c.runs.findOne({ _id: small }))?.status).toBe("queued");
  });

  it("fires a schedule once in its minute and skips it in the scan until its next one", async () => {
    await account("usr_sched");
    const wf = await addWorkflow("ws_sched", "usr_sched", { ...wfInput([transform("a", 1)]), trigger: { type: "schedule", cron: "*/10 * * * *" } });
    const base = Math.floor(Date.now() / 3_600_000) * 3_600_000; // the top of this hour fires
    // A minute that doesn't fire: nothing runs, and the next fire time is stored.
    await tick(c, base - 3 * 60_000);
    expect(await c.runs.countDocuments({ workflowId: wf.id })).toBe(0);
    expect((await c.workflows.findOne({ _id: wf.id }))?.nextFireAt).toBe(base);
    // Its minute: one run, even if two ticks land in the same minute. (At the same moment only on
    // MongoDB: FerretDB doesn't apply parallel findOneAndUpdate atomically.)
    if (ferret) {
      await tick(c, base + 1_000);
      await tick(c, base + 2_000);
    } else await Promise.all([tick(c, base + 1_000), tick(c, base + 2_000)]);
    expect(await c.runs.countDocuments({ workflowId: wf.id, triggerType: "schedule" })).toBe(1);
    expect((await c.workflows.findOne({ _id: wf.id }))?.nextFireAt).toBe(base + 10 * 60_000);
    // Saving the workflow clears it, so a changed schedule is worked out again.
    const saved = await updateWorkflow(c, wf.id, "ws_sched", { ...wfInput([transform("a", 1)]), trigger: { type: "schedule", cron: "5 * * * *" } }, wf.version, Date.now());
    expect(saved.ok).toBe(true);
    expect((await c.workflows.findOne({ _id: wf.id }))?.nextFireAt).toBeNull();
    await tick(c, base + 60_000);
    expect((await c.workflows.findOne({ _id: wf.id }))?.nextFireAt).toBe(base + 5 * 60_000);
  });

  it("caps how many runs one account can have waiting", async () => {
    await account("usr_pile");
    await c.runs.insertMany(
      Array.from({ length: 100 }, (_, i) => ({ _id: `run_pile_${i}`, ownerId: "usr_pile", status: "waiting" }) as never),
    );
    expect(await takeRunSlot(c, "usr_pile", Date.now(), "webhook")).toMatch(/100 runs waiting/);
    await c.runs.deleteMany({ ownerId: "usr_pile" });
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
