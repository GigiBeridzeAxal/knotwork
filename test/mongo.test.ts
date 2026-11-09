import { type Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkflowInput } from "../shared/schema";
import type { Workflow } from "../shared/schema";
import { deleteWorkspace, getRun, insertWorkflow, takeRunSlot, updateWorkflow } from "../worker/db";
import { ensureDemo } from "../worker/demo";
import { advance, createRun, guardStorage, tick } from "../worker/engine";
import { bump, newHookKey } from "../worker/auth";
import { type Collections, collections } from "../worker/mongo";
import { dropAll } from "./dropAll";

/**
 * Database tests. They need a MongoDB to talk to, so they only run when MONGODB_TEST_URI is set,
 * e.g. `MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test` with a local `mongod`. Each run uses
 * a fresh database and drops it at the end.
 */
const uri = process.env.MONGODB_TEST_URI;
const PEPPER = "test-pepper-0123456789abcdef";

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
    const wf = await insertWorkflow(c, ws, owner, input, Date.now(), await newHookKey(PEPPER));
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

  it("limits what runs may store per hour, per account and per pool", async () => {
    await Promise.all([account("usr_bytes"), account("usr_bytes2"), account("usr_bytes3")]);
    const now = Date.now();
    const results = [];
    for (let i = 0; i < 40; i++) results.push(await takeRunSlot(c, "usr_bytes", now, "schedule", 123_000));
    // 4 MB an hour per account: 32 runs of 123 KB, then refused, with the slot given back.
    expect(results.filter((r) => r === null)).toHaveLength(32);
    expect(results[32]).toMatch(/4 MB/);
    // Past half of the webhook and manual pool, an account that had stored more than 200 KB this hour
    // waits ...
    await bump(c, "runbytes:demand", 3_600_000, now, 30_000_000);
    try {
      expect(await takeRunSlot(c, "usr_bytes2", now, "webhook", 150_000)).toBeNull();
      expect(await takeRunSlot(c, "usr_bytes2", now, "webhook", 100_000)).toBeNull();
      expect(await takeRunSlot(c, "usr_bytes2", now, "webhook", 10_000)).toMatch(/your account.s runs have already stored 200 KB/);
      // ... but its schedules, in their own pool, and a quiet account still run.
      expect(await takeRunSlot(c, "usr_bytes2", now, "schedule", 10_000)).toBeNull();
      expect(await takeRunSlot(c, "usr_bytes3", now, "webhook", 10_000)).toBeNull();
    } finally {
      await bump(c, "runbytes:demand", 3_600_000, now, -30_000_000);
    }
  });

  it("finishes a run that started under the fair share, even when its steps take it over", async () => {
    await account("usr_fair");
    const now = Date.now();
    await bump(c, "runbytes:demand", 3_600_000, now, 31_000_000);
    await bump(c, "runbytes:usr_fair", 3_600_000, now, 170_000);
    try {
      const { runId } = await start([transform("a", 1), transform("b", "x".repeat(15_000)), transform("c", 3)], "usr_fair", "ws_fair");
      await advance(c, runId);
      const run = await c.runs.findOne({ _id: runId });
      expect(run?.status).toBe("succeeded");
      expect(run?.logs.map((l) => l.status)).toEqual(["ok", "ok", "ok"]);
    } finally {
      await bump(c, "runbytes:demand", 3_600_000, now, -31_000_000);
    }
  });

  it("gives a reservation back in the hour it was made, even when the run ends in the next", async () => {
    await account("usr_edge");
    const { runId } = await start([transform("a", 1), transform("b", 2), transform("c", 3)], "usr_edge", "ws_edge");
    // The run starts 5 ms before the hour turns, and everything after that first reading of the
    // clock happens in the next hour, however fast the database answers.
    const realNow = Date.now.bind(Date);
    const nextHour = (Math.floor(realNow() / 3_600_000) + 1) * 3_600_000;
    const begun = realNow();
    let first = true;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      if (!first) return nextHour + 5 + (realNow() - begun);
      first = false;
      return nextHour - 5;
    });
    try {
      await advance(c, runId);
      expect(Date.now()).toBeGreaterThan(nextHour);
    } finally {
      clock.mockRestore();
    }
    expect((await c.runs.findOne({ _id: runId }))?.status).toBe("succeeded");
    const window = nextHour / 3_600_000;
    for (const key of ["runbytes:usr_edge", "runbytes:demand"]) {
      expect((await c.counters.findOne({ _id: `${key}:${window}` }))?.n ?? 0, key).toBeGreaterThanOrEqual(0);
      expect((await c.counters.findOne({ _id: `${key}:${window - 1}` }))?.n ?? 0, key).toBeGreaterThan(0);
    }
  });

  it("reserves a run's most possible bytes once and gives back what it didn't use", async () => {
    await account("usr_settle");
    const { runId } = await start([transform("a", 1), transform("b", 2), transform("c", 3)], "usr_settle", "ws_settle");
    await advance(c, runId);
    expect((await c.runs.findOne({ _id: runId }))?.status).toBe("succeeded");
    const counter = await c.counters.findOne({ _id: `runbytes:usr_settle:${Math.floor(Date.now() / 3_600_000)}` });
    // Three tiny outputs and their logs: well under the ~70 KB reserved for three steps.
    expect(counter?.n).toBeGreaterThan(0);
    expect(counter?.n).toBeLessThan(2_000);
  });

  it("pauses a run when there's no room, before its next step runs, and says why", async () => {
    await account("usr_writer");
    const big = { id: "big", name: "Big", type: "transform" as const, retry: { max: 0, backoffSeconds: 5 }, config: { output: "€".repeat(6_000) } };
    const { runId } = await start([big, transform("b", 1)], "usr_writer", "ws_writer");
    await bump(c, "runbytes:usr_writer", 3_600_000, Date.now(), 3_990_000);
    await advance(c, runId);
    const run = await c.runs.findOne({ _id: runId });
    expect(run?.status).toBe("waiting");
    // Tries again in 10 minutes, or when the next hour starts if that's sooner.
    expect(run?.nextRunAt).toBeGreaterThan(Date.now());
    expect(run?.nextRunAt).toBeLessThanOrEqual(Math.min((Math.floor(Date.now() / 3_600_000) + 1) * 3_600_000, Date.now() + 600_000));
    expect(run?.error).toMatch(/^Paused: this account's runs have stored their limit this hour\. Tries again at \d\d:\d\d UTC\.$/);
    expect(run?.logs).toEqual([]);
    expect(run?.outputs).toEqual({});
    const wf = await c.workflows.findOne({ "lastRun.id": runId });
    expect(wf?.lastRun).toMatchObject({ status: "waiting", error: run?.error });
    // Once there's room, it runs on and the note goes.
    await bump(c, "runbytes:usr_writer", 3_600_000, Date.now(), -3_990_000);
    await c.runs.updateOne({ _id: runId }, { $set: { nextRunAt: Date.now() } });
    await advance(c, runId);
    const done = await c.runs.findOne({ _id: runId });
    expect([done?.status, done?.error]).toEqual(["succeeded", null]);
    expect((await c.workflows.findOne({ "lastRun.id": runId }))?.lastRun?.error).toBeUndefined();
    // 6,000 "€" are 18 KB in UTF-8: over the 16 KB a step keeps, so it would be cut, by bytes.
    const { keepable } = await import("../worker/engine");
    expect(keepable("€".repeat(6_000)).bytes).toBe(16_040);
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

  it("serves every account with ready runs in turn, whatever its id", async () => {
    await c.runs.deleteMany({ status: { $in: ["queued", "waiting"] } });
    const now = Date.now();
    const owners = [...Array.from({ length: 10 }, (_, a) => `usr_a${String(a).padStart(2, "0")}`), "usr_zz"];
    for (const owner of owners) {
      const wf = await addWorkflow(`ws_${owner}`, owner, wfInput([transform("a", 1)]));
      for (let i = 0; i < 5; i++) {
        const runId = await createRun(c, { ...wf, ownerId: owner }, "manual", {});
        await c.runs.updateOne({ _id: runId }, { $set: { nextRunAt: now - 60_000 + i } });
      }
    }
    // 11 accounts, 5 served a minute: within three ticks every one has had a turn.
    for (let t = 0; t < 3; t++) await tick(c, now + 1_000 + t * 60_000);
    for (const owner of owners) {
      expect(await c.runs.countDocuments({ ownerId: owner, status: "succeeded" }), owner).toBeGreaterThanOrEqual(1);
    }
    await c.runs.deleteMany({ status: { $in: ["queued", "waiting"] } });
  });

  it("stops and shrinks big backlogs when the database is nearly full, but not a few runs in flight", async () => {
    await c.runs.deleteMany({ status: { $in: ["queued", "waiting"] } });
    const backlog = async (owner: string, n: number) => {
      const wf = await addWorkflow(`ws_${owner}`, owner, wfInput([transform("a", 1)]));
      const ids = [];
      for (let i = 0; i < n; i++) ids.push(await createRun(c, { ...wf, ownerId: owner }, "manual", {}));
      return { wf, ids };
    };
    const heap = await backlog("usr_heap", 30);
    await backlog("usr_m1", 25);
    await backlog("usr_m2", 22);
    await backlog("usr_m3", 21);
    const few = await backlog("usr_few", 3);
    // Nearly full at first; after the backlogs shrink, back under the pruning mark, so nobody's
    // finished runs are deleted.
    const finished = await createRun(c, { ...few.wf, ownerId: "usr_few" }, "manual", {});
    await c.runs.updateOne({ _id: finished }, { $set: { status: "succeeded" } });
    const sizes = [400_000_000, 300_000_000];
    const nearlyFull = { stats: async () => ({ dataSize: sizes.shift() ?? 300_000_000, indexSize: 0 }) } as unknown as Db;
    await guardStorage(c, nearlyFull, Date.now());
    expect(await c.runs.findOne({ _id: finished })).not.toBeNull();
    // The backlogs over 20 are stopped and shrunk, and their workflows show it.
    expect(await c.runs.countDocuments({ _id: { $in: heap.ids }, status: "stopped" })).toBe(30);
    const shrunk = await c.runs.findOne({ _id: heap.ids[0] });
    expect([shrunk?.steps, shrunk?.input, shrunk?.outputs]).toEqual([[], null, {}]);
    expect(await c.runs.countDocuments({ ownerId: { $in: ["usr_m1", "usr_m2", "usr_m3"] }, status: "stopped" })).toBe(68);
    expect((await c.workflows.findOne({ _id: heap.wf.id }))?.lastRun?.status).toBe("stopped");
    expect((await c.runs.findOne({ _id: heap.ids[0] }))?.error).toMatch(/free space/);
    // An account with only a few in flight is left alone.
    expect(await c.runs.countDocuments({ _id: { $in: few.ids }, status: "queued" })).toBe(3);
    await c.runs.deleteMany({ status: { $in: ["queued", "waiting"] } });
  });

  it("shrinks many accounts' moderate backlogs before recent history, and any backlog near full", { timeout: 180_000 }, async () => {
    await c.runs.deleteMany({});
    const pendingRun = (owner: string, i: number) =>
      ({ _id: `run_${owner}_${i}`, ownerId: owner, workflowId: `wf_${owner}`, status: "waiting", steps: [], input: { big: "x" }, outputs: {}, logs: [], createdAt: 1 }) as never;
    // 100 accounts holding 20 waiting runs each, and one account's finished run.
    await c.runs.insertMany(Array.from({ length: 100 }, (_, a) => Array.from({ length: 20 }, (_, i) => pendingRun(`usr_s${a}`, i))).flat());
    await c.runs.insertOne({ _id: "run_history", ownerId: "usr_h", status: "succeeded", createdAt: 0 } as never);
    // The moderate backlogs go before anyone's recent history; here that frees enough.
    const sizes = [460_000_000, 300_000_000];
    const stub = { stats: async () => ({ dataSize: sizes.shift() ?? 300_000_000, indexSize: 0 }) } as unknown as Db;
    await guardStorage(c, stub, Date.now());
    expect(await c.runs.countDocuments({ status: "stopped", input: null })).toBe(2_000);
    expect(await c.runs.findOne({ _id: "run_history" })).not.toBeNull();

    // Many accounts with one waiting run each: history goes first, then, near full, those runs too.
    await c.runs.deleteMany({});
    await c.runs.insertMany(Array.from({ length: 30 }, (_, a) => pendingRun(`usr_one${a}`, 0)));
    await c.runs.insertOne({ _id: "run_history", ownerId: "usr_h", status: "succeeded", createdAt: 0 } as never);
    const full = [490_000_000, 490_000_000, 300_000_000];
    const stub2 = { stats: async () => ({ dataSize: full.shift() ?? 300_000_000, indexSize: 0 }) } as unknown as Db;
    expect(await guardStorage(c, stub2, Date.now())).toBe(300_000_000);
    expect(await c.runs.findOne({ _id: "run_history" })).toBeNull();
    expect(await c.runs.countDocuments({ status: "stopped" })).toBe(30);
    await c.runs.deleteMany({});
  });

  it("trims long histories to their newest 50 before stopping an ordinary account's few runs in flight", async () => {
    await c.runs.deleteMany({});
    const now = Date.now();
    const waiting = Array.from({ length: 5 }, (_, i) => ({ _id: `run_live_${i}`, ownerId: "usr_live", status: "waiting", nextRunAt: now + 600_000, createdAt: now }) as never);
    const history = Array.from({ length: 300 }, (_, i) => ({ _id: `run_old_${i}`, ownerId: "usr_old", status: "succeeded", createdAt: i }) as never);
    await c.runs.insertMany([...waiting, ...history]);
    const sizes = [380_000_000, 200_000_000];
    await guardStorage(c, { stats: async () => ({ dataSize: sizes.shift() ?? 200_000_000, indexSize: 0 }) } as unknown as Db, now);
    expect(await c.runs.countDocuments({ ownerId: "usr_live", status: "waiting" })).toBe(5);
    expect(await c.runs.countDocuments({ ownerId: "usr_old" })).toBe(50);
    expect(await c.runs.countDocuments({ ownerId: "usr_old", createdAt: { $gte: 250 } })).toBe(50);
    await c.runs.deleteMany({});
  });

  it("keeps a quiet account's recent runs while busier accounts still have older history to trim", async () => {
    await c.runs.deleteMany({});
    const history = (owner: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ _id: `run_${owner}_${i}`, ownerId: owner, status: "succeeded", createdAt: 1_000 + i }) as never);
    // Ten accounts with 100 finished runs each (more than one check trims), and a quiet one with 10 older runs.
    await c.runs.insertMany([...["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].flatMap((x) => history(`usr_busy_${x}`, 100)), ...history("usr_quiet", 10).map((r: any) => ({ ...r, createdAt: 0 }))]);
    await guardStorage(c, { stats: async () => ({ dataSize: 380 * 1024 * 1024, indexSize: 0 }) } as unknown as Db, Date.now());
    expect(await c.runs.countDocuments({ ownerId: "usr_quiet" })).toBe(10);
    await c.runs.deleteMany({});
  });

  it("deletes old history before stopping runs in flight near full, even while accounts keep adding history", async () => {
    await c.runs.deleteMany({});
    const now = Date.now();
    const finished = (owner: string, n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ _id: `run_${owner}_${from + i}`, ownerId: owner, status: "succeeded", createdAt: from + i }) as never);
    // 5 accounts just over 50 finished runs (finishing one a minute), 10 accounts at exactly 50 old
    // ones, and an ordinary account with 3 runs waiting.
    await c.runs.insertMany([
      ...["a", "b", "c", "d", "e"].flatMap((x) => finished(`usr_decoy_${x}`, 51, 10_000)),
      ...Array.from({ length: 10 }, (_, h) => finished(`usr_holder_${h}`, 50, 0)).flat(),
      ...Array.from({ length: 3 }, (_, i) => ({ _id: `run_legit_${i}`, ownerId: "usr_legit", status: "waiting", nextRunAt: now + 600_000, createdAt: now }) as never),
    ]);
    // Between the pruning and full marks: the decoys' few extra runs don't hold back step 5.
    await guardStorage(c, { stats: async () => ({ dataSize: 420 * 1024 * 1024, indexSize: 0 }) } as unknown as Db, now);
    expect(await c.runs.countDocuments({ ownerId: /^usr_holder/ })).toBeLessThan(500);
    // Past the full mark: old history goes before the ordinary account's runs in flight.
    await c.runs.deleteMany({ ownerId: /^usr_(holder|decoy)/ });
    await c.runs.insertMany([...["a", "b", "c", "d", "e"].flatMap((x) => finished(`usr_decoy_${x}`, 200, 10_000)), ...Array.from({ length: 10 }, (_, h) => finished(`usr_holder_${h}`, 50, 0)).flat()]);
    const sizes = [460 * 1024 * 1024, 460 * 1024 * 1024, 300 * 1024 * 1024];
    await guardStorage(c, { stats: async () => ({ dataSize: sizes.shift() ?? 300 * 1024 * 1024, indexSize: 0 }) } as unknown as Db, now);
    expect(await c.runs.countDocuments({ ownerId: "usr_legit", status: "waiting" })).toBe(3);
    expect(await c.runs.countDocuments({ ownerId: /^usr_holder/ })).toBeLessThan(500);
    await c.runs.deleteMany({});
  });

  it("keeps trimming one very busy account's older history before anyone else's recent runs go", async () => {
    await c.runs.deleteMany({});
    await c.runs.insertMany([
      ...Array.from({ length: 10 }, (_, i) => ({ _id: `run_q_${i}`, ownerId: "usr_q10", status: "succeeded", createdAt: i }) as never),
      ...Array.from({ length: 5_000 }, (_, i) => ({ _id: `run_busy_${i}`, ownerId: "usr_busy", status: "succeeded", createdAt: 100 + i }) as never),
    ]);
    const stats = { stats: async () => ({ dataSize: 380 * 1024 * 1024, indexSize: 0 }) } as unknown as Db;
    await guardStorage(c, stats, Date.now());
    expect(await c.runs.countDocuments({ ownerId: "usr_q10" })).toBe(10);
    // The busy account's oldest runs went first.
    expect(await c.runs.countDocuments({ ownerId: "usr_busy" })).toBe(3_000);
    expect(await c.runs.findOne({ _id: "run_busy_1999" })).toBeNull();
    await guardStorage(c, stats, Date.now());
    expect(await c.runs.countDocuments({ ownerId: "usr_q10" })).toBe(10);
    expect(await c.runs.countDocuments({ ownerId: "usr_busy" })).toBe(1_000);
    await c.runs.deleteMany({});
  });

  it("leaves an account's few runs in flight alone while older history is still being trimmed", async () => {
    await c.runs.deleteMany({});
    const now = Date.now();
    await c.runs.insertMany([
      ...Array.from({ length: 5 }, (_, i) => ({ _id: `run_fly_${i}`, ownerId: "usr_fly", status: "waiting", nextRunAt: now + 600_000, createdAt: now }) as never),
      ...Array.from({ length: 5_000 }, (_, i) => ({ _id: `run_hist_${i}`, ownerId: "usr_hist", status: "succeeded", createdAt: i }) as never),
    ]);
    const stats = { stats: async () => ({ dataSize: 380 * 1024 * 1024, indexSize: 0 }) } as unknown as Db;
    await guardStorage(c, stats, now);
    await guardStorage(c, stats, now);
    expect(await c.runs.countDocuments({ ownerId: "usr_fly", status: "waiting" })).toBe(5);
    expect(await c.runs.countDocuments({ ownerId: "usr_hist" })).toBe(1_000);
    // With the older history gone, the next check stops them (which here frees enough).
    const sizes = [380 * 1024 * 1024, 380 * 1024 * 1024, 300 * 1024 * 1024];
    await guardStorage(c, { stats: async () => ({ dataSize: sizes.shift() ?? 300 * 1024 * 1024, indexSize: 0 }) } as unknown as Db, now);
    expect(await c.runs.countDocuments({ ownerId: "usr_fly", status: "stopped" })).toBe(5);
    await c.runs.deleteMany({});
  });

  it("clears the full flag in the same check that frees the space", async () => {
    await c.runs.deleteMany({});
    await c.counters.deleteMany({ _id: { $in: ["storage:high", "storage:full"] } });
    await c.runs.insertOne({ _id: "run_wait_far", ownerId: "usr_far", status: "waiting", nextRunAt: Date.now() + 3 * 86_400_000, createdAt: 1 } as never);
    const sizes = [460 * 1024 * 1024, 340 * 1024 * 1024];
    await guardStorage(c, { stats: async () => ({ dataSize: sizes.shift() ?? 340 * 1024 * 1024, indexSize: 0 }) } as unknown as Db, Date.now());
    expect(await c.counters.findOne({ _id: "storage:full" })).toBeNull();
    expect(await c.counters.findOne({ _id: "storage:high" })).not.toBeNull();
    await c.runs.deleteMany({});
  });

  it("stops many mid-sized backlogs before anyone loses their newest 50 finished runs", async () => {
    await c.runs.deleteMany({});
    const now = Date.now();
    // 20 accounts each holding 20 waiting runs (under the big-backlog mark), and 3 ordinary accounts
    // with 200 finished runs each.
    const waiting = Array.from({ length: 20 }, (_, a) =>
      Array.from({ length: 20 }, (_, i) => ({ _id: `run_mid_${a}_${i}`, ownerId: `usr_mid${a}`, status: "waiting", nextRunAt: now + 3_600_000, createdAt: now }) as never),
    ).flat();
    const history = ["usr_h1", "usr_h2", "usr_h3"].flatMap((owner) =>
      Array.from({ length: 200 }, (_, i) => ({ _id: `run_${owner}_${i}`, ownerId: owner, status: "succeeded", createdAt: i }) as never),
    );
    await c.runs.insertMany([...waiting, ...history]);
    // Still full after the older history goes; under the mark once the backlogs are stopped.
    const sizes = [380_000_000, 380_000_000, 200_000_000];
    await guardStorage(c, { stats: async () => ({ dataSize: sizes.shift() ?? 200_000_000, indexSize: 0 }) } as unknown as Db, now);
    for (const owner of ["usr_h1", "usr_h2", "usr_h3"]) {
      expect(await c.runs.countDocuments({ ownerId: owner, createdAt: { $gte: 150 } }), owner).toBe(50);
      expect(await c.runs.countDocuments({ ownerId: owner }), owner).toBe(50);
    }
    expect(await c.runs.countDocuments({ ownerId: /^usr_mid/, status: "stopped" })).toBe(400);
    await c.runs.deleteMany({});
  });

  it("shrinks runs waiting more than a day ahead before anyone's history, and checks every minute while high", async () => {
    await c.runs.deleteMany({});
    await c.counters.deleteMany({ _id: { $in: ["storage:high", "storage:full"] } });
    const now = Date.now();
    const run = (id: string, owner: string, wake: number) =>
      ({ _id: id, ownerId: owner, workflowId: "wf_x", status: "waiting", nextRunAt: wake, steps: [], input: {}, outputs: {}, logs: [], createdAt: 1 }) as never;
    await c.runs.insertMany([run("run_far1", "usr_f1", now + 3 * 86_400_000), run("run_far2", "usr_f2", now + 6 * 86_400_000), run("run_soon", "usr_f3", now + 60_000)]);
    await c.runs.insertOne({ _id: "run_hist", ownerId: "usr_h", status: "succeeded", createdAt: 0 } as never);
    const sizes = [380_000_000, 300_000_000];
    await guardStorage(c, { stats: async () => ({ dataSize: sizes.shift() ?? 300_000_000, indexSize: 0 }) } as unknown as Db, now);
    expect((await c.runs.find({ status: "stopped" }).toArray()).map((r) => r._id).sort()).toEqual(["run_far1", "run_far2"]);
    expect(await c.runs.findOne({ _id: "run_hist" })).not.toBeNull();
    // 300 MB is above the watch mark: the next tick, at a minute that isn't a multiple of 10, checks.
    expect(await c.counters.findOne({ _id: "storage:high" })).not.toBeNull();
    let checked = 0;
    const watched = { stats: async () => ((checked += 1), { dataSize: 200_000_000, indexSize: 0 }) } as unknown as Db;
    const minute = Math.floor(now / 600_000) * 600_000 + 3 * 60_000;
    await tick(c, minute + 1_000, watched);
    expect(checked).toBe(1);
    expect(await c.counters.findOne({ _id: "storage:high" })).toBeNull();
    await c.runs.deleteMany({});
  });

  it("leaves a schedule saved during the tick to be worked out again", async () => {
    const input = { ...wfInput([transform("a", 1)]), trigger: { type: "schedule" as const, cron: "0 0 1 1 *" } };
    const wf = await addWorkflow("ws_race", "usr_race", input);
    // The save lands after the tick read the workflow: its version no longer matches the scan's.
    await c.workflows.updateOne({ _id: wf.id }, { $inc: { version: 1 } });
    const scanned = c.workflows.find.bind(c.workflows);
    const base = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    let calls = 0;
    (c.workflows as { find: unknown }).find = (...args: Parameters<typeof scanned>) => {
      const cursor = scanned(...args);
      if (calls++ === 0) {
        const toArray = cursor.toArray.bind(cursor);
        cursor.toArray = async () => (await toArray()).map((d) => (d._id === wf.id ? { ...d, version: (d.version ?? 1) - 1 } : d));
      }
      return cursor;
    };
    try {
      await tick(c, base + 3 * 60_000);
    } finally {
      (c.workflows as { find: unknown }).find = scanned;
    }
    expect((await c.workflows.findOne({ _id: wf.id }))?.nextFireAt ?? null).toBeNull();
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
    const results = await Promise.all(Array.from({ length: 14 }, async () => insertWorkflow(c, "ws_full", "usr_f", wfInput([]), Date.now(), await newHookKey(PEPPER))));
    expect(results.filter((r) => typeof r !== "string").length).toBeLessThanOrEqual(10);
    expect(await c.workflows.countDocuments({ workspaceId: "ws_full" })).toBeLessThanOrEqual(10);
    expect(await insertWorkflow(c, "ws_missing", "usr_f", wfInput([]), Date.now(), await newHookKey(PEPPER))).toBe("gone");
  });

  it("seeds the demo account once, even when many people open it at the same moment", async () => {
    await Promise.all(Array.from({ length: 5 }, () => ensureDemo(c, Date.now(), PEPPER)));
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
