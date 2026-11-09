import { type Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../shared/limits";
import type { Step, WorkflowInput } from "../shared/schema";
import { newHookKey } from "../worker/auth";
import { insertWorkflow } from "../worker/db";
import { advance, createRun } from "../worker/engine";
import { type Collections, collections, type RunDoc } from "../worker/mongo";
import { loadSecrets, putSecret } from "../worker/secrets";
import { dropAll } from "./dropAll";

/**
 * The engine running if and loop blocks, and workspace secrets, against a database
 * (MONGODB_TEST_URI). Each run of this file uses a fresh database and drops it at the end.
 */
const uri = process.env.MONGODB_TEST_URI;
const PEPPER = "test-pepper-0123456789abcdef";

describe.skipIf(!uri)("blocks and secrets in the engine", () => {
  let client: MongoClient;
  let db: Db;
  let c: Collections;

  beforeAll(async () => {
    client = await MongoClient.connect(uri!);
    db = client.db(`knotwork_blocks_test_${Date.now()}`);
    c = collections(db);
  });

  afterAll(async () => {
    if (db) await dropAll(db);
    await client?.close();
  });

  const retry = { max: 0, backoffSeconds: 5 };
  const transform = (id: string, output: unknown): Step => ({ id, name: id, type: "transform", retry, config: { output } });
  const log = (id: string, message: string): Step => ({ id, name: id, type: "log", retry, config: { message } });
  const filter = (id: string, left: string, op: "equals" | "not_equals", right: string): Step => ({ id, name: id, type: "filter", retry, config: { left, op, right } });
  const delay = (id: string, seconds = 60): Step => ({ id, name: id, type: "delay", retry, config: { seconds } });
  const http = (id: string, url: string): Step => ({
    id,
    name: id,
    type: "http",
    retry,
    config: { method: "GET", url, headers: {}, failOnError: true },
  });
  const ifStep = (id: string, left: string, op: "equals" | "exists" | "gt", right: string, then: Step[], otherwise: Step[] = []): Step => ({
    id,
    name: id,
    type: "if",
    retry,
    config: { left, op, right },
    then,
    else: otherwise,
  });
  const loop = (id: string, items: string, steps: Step[]): Step => ({ id, name: id, type: "loop", retry, config: { items }, steps });

  let n = 0;
  /** Each test gets its own workspace and account, so workflow and byte limits don't carry over. */
  async function start(steps: Step[], input: unknown = { body: {} }, ws = `ws_blk_${++n}`, owner = `usr_blk_${n}`) {
    await c.workspaces.updateOne({ _id: ws }, { $setOnInsert: { ownerId: owner, name: ws, personal: false, createdAt: 1 } }, { upsert: true });
    const wfInput: WorkflowInput = { name: "Blocks", description: "", enabled: true, trigger: { type: "manual" }, steps };
    const wf = await insertWorkflow(c, ws, owner, wfInput, Date.now(), await newHookKey(PEPPER));
    if (typeof wf === "string") throw new Error(`insert refused: ${wf}`);
    const runId = await createRun(c, { ...wf, ownerId: owner }, "manual", input);
    return { runId, ws, owner };
  }

  const load = async (runId: string) => (await c.runs.findOne({ _id: runId })) as RunDoc;
  /** Wakes a parked run now, as the cron would once its time comes. */
  async function resume(runId: string, pepper = "") {
    await c.runs.updateOne({ _id: runId }, { $set: { nextRunAt: 0 } });
    await advance(c, runId, pepper);
  }
  const storedBytes = (outputs: Record<string, unknown>) =>
    Object.values(outputs).reduce<number>((sum, v) => sum + new TextEncoder().encode(JSON.stringify(v)).byteLength, 0);

  // ---------- if ----------

  it("runs the then branch of an if, logs the if once, and skips the else branch", async () => {
    const { runId } = await start(
      [
        ifStep("check", "{{ trigger.body.n }}", "gt", "1", [transform("big", "yes")], [transform("small", "no")]),
        transform("after", { result: "{{ steps.check.result }}", branch: "{{ steps.check.branch }}" }),
      ],
      { body: { n: 5 } },
    );
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("succeeded");
    expect(run.logs.map((l) => [l.stepId, l.status, l.depth ?? 0])).toEqual([
      ["check", "ok", 0],
      ["big", "ok", 1],
      ["after", "ok", 0],
    ]);
    expect(run.logs[0].output).toEqual({ result: true, branch: "then" });
    expect(run.outputs).toEqual({ check: { result: true, branch: "then" }, big: "yes", after: { result: true, branch: "then" } });
  });

  it("runs the else branch when the condition is false, and nothing for an empty branch", async () => {
    const { runId } = await start(
      [
        ifStep("check", "{{ trigger.body.n }}", "gt", "1", [transform("big", "yes")], [transform("small", "no")]),
        ifStep("nothing", "{{ trigger.body.n }}", "gt", "1", [transform("never", 1)]),
        transform("after", "done"),
      ],
      { body: { n: 0 } },
    );
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("succeeded");
    expect(run.logs.map((l) => l.stepId)).toEqual(["check", "small", "nothing", "after"]);
    expect(run.logs[0].output).toEqual({ result: false, branch: "else" });
    expect(run.logs[2].output).toEqual({ result: false, branch: "else" });
    expect(run.outputs).not.toHaveProperty("big");
    expect(run.outputs).not.toHaveProperty("never");
  });

  it("stops the whole run when a filter inside an if stops", async () => {
    const { runId } = await start(
      [
        ifStep("check", "{{ trigger.body.kind }}", "exists", "", [filter("only_paid", "{{ trigger.body.kind }}", "equals", "paid"), transform("inside", 1)]),
        transform("after", 2),
      ],
      { body: { kind: "refund" } },
    );
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("stopped");
    expect(run.logs.map((l) => [l.stepId, l.status])).toEqual([
      ["check", "ok"],
      ["only_paid", "stopped"],
    ]);
    expect(run.outputs).not.toHaveProperty("after");
  });

  // ---------- loop ----------

  it("goes through a list, with the item, index and count in templates, and logs each pass", async () => {
    const { runId } = await start(
      [
        loop("each", "{{ trigger.body.list }}", [
          transform("t", { item: "{{ loop.item }}", index: "{{ loop.index }}", count: "{{ loop.count }}", via: "{{ steps.each.item }}" }),
          log("say", "item {{ loop.item }}"),
        ]),
        transform("after", { loop: "{{ steps.each }}", last: "{{ steps.t.item }}", outside: "{{ loop.item }}" }),
      ],
      { body: { list: ["x", "yy", "zzz"] } },
    );
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("succeeded");
    expect(run.logs.map((l) => [l.stepId, l.pass ?? null, l.depth ?? 0])).toEqual([
      ["each", null, 0],
      ["t", "1 of 3", 1],
      ["say", "1 of 3", 1],
      ["t", "2 of 3", 1],
      ["say", "2 of 3", 1],
      ["t", "3 of 3", 1],
      ["say", "3 of 3", 1],
      ["after", null, 0],
    ]);
    expect(run.logs[0].output).toEqual({ count: 3 });
    expect(run.logs.filter((l) => l.stepId === "t").map((l) => l.output)).toEqual([
      { item: "x", index: 0, count: 3, via: "x" },
      { item: "yy", index: 1, count: 3, via: "yy" },
      { item: "zzz", index: 2, count: 3, via: "zzz" },
    ]);
    expect(run.logs.filter((l) => l.stepId === "say").map((l) => l.message)).toEqual(["item x", "item yy", "item zzz"]);
    // After the loop only the count is left, and `loop` means nothing outside one.
    expect(run.outputs.each).toEqual({ count: 3 });
    // (`outside` rendered to nothing, so it isn't stored.)
    expect(run.outputs.after).toEqual({ loop: { count: 3 }, last: "zzz" });
    // The loop's start, 3 passes of 2 steps (the last one ends the loop), and "after".
    expect(run.stepRuns).toBe(1 + 3 * 2 + 1);
  });

  it("keeps only the last pass's outputs and counts their size as stored now, not summed", async () => {
    const items = ["a".repeat(3_000), "b".repeat(3_000), "c"];
    const { runId } = await start([loop("each", "{{ trigger.body.list }}", [transform("t", "{{ loop.item }}")])], { body: { list: items } });
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("succeeded");
    expect(run.outputs).toEqual({ each: { count: 3 }, t: "c" });
    expect(run.outputBytes).toBe(storedBytes(run.outputs));
    expect(run.outputBytes).toBeLessThan(100);
  });

  it("fails a loop whose list is larger than one output may be", async () => {
    // About 20 KB of list: more than the 16 KB a loop can keep as its place.
    const list = Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(1_000, "x"));
    const { runId } = await start([loop("each", "{{ trigger.body.list }}", [transform("t", "{{ loop.item }}")])], { body: { list } });
    await advance(c, runId);
    const tooBig = await load(runId);
    expect(tooBig.status).toBe("failed");
    expect(tooBig.error).toMatch(/list is larger than 16 KB/);
  });

  it("lets a loop write more in total than a run's outputs may hold, since each pass replaces the last", async () => {
    // 20 passes of a 10 KB output: 200 KB written, but never more than one 10 KB output stored at once.
    const small = Array.from({ length: 20 }, (_, i) => i);
    const { runId: ok } = await start(
      [loop("each", "{{ trigger.body.list }}", [transform("t", { n: "{{ loop.item }}", pad: "{{ trigger.body.pad }}" })])],
      { body: { list: small, pad: "p".repeat(10_000) } },
    );
    await advance(c, ok);
    const run = await load(ok);
    expect(run.status).toBe("succeeded");
    expect(run.outputs.t).toMatchObject({ n: 19 });
    expect(run.outputBytes).toBe(storedBytes(run.outputs));
  });

  it("skips the steps of a loop over an empty list and goes on", async () => {
    const { runId } = await start([loop("each", "{{ trigger.body.list }}", [transform("inside", 1)]), transform("after", 2)], { body: { list: [] } });
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("succeeded");
    expect(run.logs.map((l) => [l.stepId, l.status])).toEqual([
      ["each", "ok"],
      ["after", "ok"],
    ]);
    expect(run.logs[0].output).toEqual({ count: 0 });
    expect(run.outputs).toEqual({ each: { count: 0 }, after: 2 });
  });

  it("fails a loop over something that isn't a list", async () => {
    const { runId } = await start([loop("each", "{{ trigger.body.list }}", [transform("inside", 1)]), transform("after", 2)], { body: { list: { a: 1 } } });
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/^each: .*gave an object, not a list/);
    expect(run.logs.map((l) => [l.stepId, l.status])).toEqual([["each", "failed"]]);
  });

  it("fails a loop over more than 50 items instead of cutting the list short", async () => {
    const list = Array.from({ length: LIMITS.loopItems + 1 }, (_, i) => i);
    const { runId } = await start([loop("each", "{{ trigger.body.list }}", [transform("inside", 1)])], { body: { list } });
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/51 items.*at most 50/);
    expect(run.outputs).not.toHaveProperty("inside");
  });

  it("stops the whole run when a filter inside a loop stops, on the pass where it does", async () => {
    const { runId } = await start(
      [loop("each", "{{ trigger.body.list }}", [filter("not_b", "{{ loop.item }}", "not_equals", "b"), transform("t", "{{ loop.item }}")]), transform("after", 1)],
      { body: { list: ["a", "b", "c"] } },
    );
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("stopped");
    expect(run.logs.map((l) => [l.stepId, l.status, l.pass ?? null])).toEqual([
      ["each", "ok", null],
      ["not_b", "ok", "1 of 3"],
      ["t", "ok", "1 of 3"],
      ["not_b", "stopped", "2 of 3"],
    ]);
    // The second pass started clean, so the first pass's result isn't left behind as if it were this one's.
    expect(run.outputs).not.toHaveProperty("t");
    expect(run.outputs).not.toHaveProperty("after");
  });

  it("parks on a delay inside a loop and carries on with the same item afterwards", async () => {
    const { runId } = await start(
      [loop("each", "{{ trigger.body.list }}", [transform("before", "{{ loop.item }}"), delay("wait"), transform("after_wait", "{{ loop.item }}")]), transform("done", "{{ steps.each }}")],
      { body: { list: [1, 2] } },
    );
    await advance(c, runId);
    let run = await load(runId);
    expect(run.status).toBe("waiting");
    expect(run.nextRunAt).toBeGreaterThan(Date.now() + 50_000);
    // While it waits, the loop's stored output says where it is.
    expect(run.outputs.each).toEqual({ items: [1, 2], index: 0, count: 2 });
    expect(run.outputs.before).toBe(1);
    expect(run.logs.at(-1)).toMatchObject({ stepId: "wait", status: "waiting", pass: "1 of 2", depth: 1 });

    await resume(runId);
    run = await load(runId);
    expect(run.status).toBe("waiting");
    expect(run.logs.filter((l) => l.stepId === "after_wait").map((l) => l.output)).toEqual([1]);
    // The second pass starts clean: the step after the wait hasn't run for this item yet.
    expect(run.outputs).not.toHaveProperty("after_wait");
    expect(run.outputs.each).toEqual({ items: [1, 2], index: 1, count: 2 });
    expect(run.outputs.before).toBe(2);

    await resume(runId);
    run = await load(runId);
    expect(run.status).toBe("succeeded");
    expect(run.logs.filter((l) => l.stepId === "after_wait").map((l) => [l.output, l.pass])).toEqual([
      [1, "1 of 2"],
      [2, "2 of 2"],
    ]);
    expect(run.outputs.done).toEqual({ count: 2 });
  });

  it("runs nested loops, restarting the inner one on each outer pass", async () => {
    const { runId } = await start(
      [
        loop("outer", "{{ trigger.body.groups }}", [
          loop("inner", "{{ loop.item.letters }}", [transform("pair", "{{ steps.outer.index }}:{{ loop.item }}:{{ loop.count }}")]),
        ]),
      ],
      // Lists of objects rather than lists of lists: FerretDB can't store nested arrays.
      { body: { groups: [{ letters: ["a", "b"] }, { letters: ["c"] }] } },
    );
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("succeeded");
    expect(run.logs.map((l) => [l.stepId, l.pass ?? null, l.depth ?? 0, l.output])).toEqual([
      ["outer", null, 0, { count: 2 }],
      ["inner", "1 of 2", 1, { count: 2 }],
      ["pair", "1 of 2, 1 of 2", 2, "0:a:2"],
      ["pair", "1 of 2, 2 of 2", 2, "0:b:2"],
      ["inner", "2 of 2", 1, { count: 1 }],
      ["pair", "2 of 2, 1 of 1", 2, "1:c:1"],
    ]);
    expect(run.outputs).toEqual({ outer: { count: 2 }, inner: { count: 1 }, pair: "1:c:1" });
  });

  it("lets a loop over 50 items with 3 steps finish: moving to the next item is not a step run", async () => {
    const inner = ["s1", "s2", "s3"].map((id) => transform(id, "{{ loop.index }}"));
    const list = Array.from({ length: 50 }, (_, i) => i);
    const { runId } = await start([loop("each", "{{ trigger.body.list }}", inner), transform("after", 1)], { body: { list } });
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("succeeded");
    expect(run.stepRuns).toBe(1 + 50 * 3 + 1);
    expect(run.outputs).toMatchObject({ each: { count: 50 }, s3: 49, after: 1 });
  });

  it("saves steps that only compute together, not one write each", async () => {
    const inner = ["s1", "s2", "s3"].map((id) => transform(id, "{{ loop.index }}"));
    const list = Array.from({ length: 50 }, (_, i) => i);
    const { runId } = await start([loop("each", "{{ trigger.body.list }}", inner)], { body: { list } });
    const real = c.runs.updateOne.bind(c.runs);
    let writes = 0;
    c.runs.updateOne = ((...args: Parameters<typeof real>) => (writes++, real(...args))) as typeof real;
    try {
      await advance(c, runId);
    } finally {
      c.runs.updateOne = real;
    }
    expect((await load(runId)).status).toBe("succeeded");
    // 151 step runs; the claim, a save every 25 log lines and the finish. It was one write per step.
    expect(writes).toBeLessThan(15);
  });

  it("allows a run exactly 200 step runs, counting every pass", async () => {
    // 1 + 1 + 33 × 6 steps = 200.
    const inner = ["s1", "s2", "s3", "s4", "s5", "s6"].map((id) => transform(id, "{{ loop.index }}"));
    const list = Array.from({ length: 33 }, (_, i) => i);
    const { runId } = await start([transform("first", 1), loop("each", "{{ trigger.body.list }}", inner)], { body: { list } });
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("succeeded");
    expect(run.stepRuns).toBe(LIMITS.stepRunsPerRun);
  });

  it("fails a run once it has taken 200 step runs", async () => {
    // 1 + 50 × 4 steps = 201: the last step of the last pass is one too many.
    const inner = ["s1", "s2", "s3", "s4"].map((id) => transform(id, "{{ loop.index }}"));
    const list = Array.from({ length: 50 }, (_, i) => i);
    const { runId } = await start([loop("each", "{{ trigger.body.list }}", inner), transform("after", 1)], { body: { list } });
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/reached 200 steps/);
    expect(run.stepRuns).toBe(LIMITS.stepRunsPerRun);
    expect(run.outputs.s3).toBe(49);
    expect(run.outputs).not.toHaveProperty("after");
    expect(run.logs.at(-1)).toMatchObject({ stepId: "s4", status: "failed", pass: "50 of 50" });
  });

  it("counts step runs across waits, so a parked run can't start its allowance over", async () => {
    const { runId } = await start([loop("each", "{{ trigger.body.list }}", [delay("wait"), transform("t", 1)])], { body: { list: [1, 2, 3] } });
    await advance(c, runId);
    expect((await load(runId)).stepRuns).toBe(2);
    // Pretend the run is just under the limit; it must fail on the next step.
    await c.runs.updateOne({ _id: runId }, { $set: { stepRuns: LIMITS.stepRunsPerRun - 1 } });
    await resume(runId);
    const run = await load(runId);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/reached 200 steps/);
    expect(run.stepRuns).toBe(LIMITS.stepRunsPerRun);
  });

  it("takes a different branch of an if inside a loop on each pass", async () => {
    const { runId } = await start(
      [
        loop("each", "{{ trigger.body.list }}", [
          ifStep("big", "{{ loop.item }}", "gt", "10", [transform("high", "{{ loop.item }} is big")], [transform("low", "{{ loop.item }} is small")]),
          transform("seen", "{{ steps.big.branch }}"),
        ]),
      ],
      { body: { list: [5, 50, 7] } },
    );
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("succeeded");
    expect(run.logs.map((l) => [l.stepId, l.pass ?? null, l.depth ?? 0])).toEqual([
      ["each", null, 0],
      ["big", "1 of 3", 1],
      ["low", "1 of 3", 2],
      ["seen", "1 of 3", 1],
      ["big", "2 of 3", 1],
      ["high", "2 of 3", 2],
      ["seen", "2 of 3", 1],
      ["big", "3 of 3", 1],
      ["low", "3 of 3", 2],
      ["seen", "3 of 3", 1],
    ]);
    expect(run.logs.filter((l) => l.stepId === "seen").map((l) => l.output)).toEqual(["else", "then", "else"]);
    // What is left is the last pass: the branch it didn't take holds nothing from an earlier item.
    expect(run.outputs).toMatchObject({ low: "7 is small", seen: "else" });
    expect(run.outputs).not.toHaveProperty("high");
  });

  it("retries a failed step inside a loop on the same item", async () => {
    const failing: Step = { ...http("call", "not a url {{ loop.item }}"), retry: { max: 1, backoffSeconds: 1 } };
    const { runId } = await start([loop("each", "{{ trigger.body.list }}", [transform("t", "{{ loop.item }}"), failing])], { body: { list: ["a", "b"] } });
    await advance(c, runId);
    let run = await load(runId);
    expect(run.status).toBe("waiting");
    expect(run.logs.at(-1)).toMatchObject({ stepId: "call", status: "retrying", pass: "1 of 2" });
    await resume(runId);
    run = await load(runId);
    expect(run.status).toBe("failed");
    expect(run.logs.at(-1)).toMatchObject({ stepId: "call", status: "failed", pass: "1 of 2", attempt: 2 });
    expect(run.logs.at(-1)?.message).toMatch(/not a url a/);
    expect(run.outputs.t).toBe("a");
  });

  it("doesn't fail on a missing secret named only in a branch that isn't taken", async () => {
    const { runId } = await start(
      [ifStep("check", "{{ trigger.body.n }}", "gt", "1", [transform("needs", "{{ secrets.ONLY_IN_THEN }}")], [transform("other", 1)])],
      { body: { n: 0 } },
    );
    await advance(c, runId, PEPPER);
    const run = await load(runId);
    expect(run.status).toBe("succeeded");
    expect(run.outputs).toMatchObject({ other: 1 });
  });

  // ---------- older runs ----------

  it("still runs a run saved before step runs were counted", async () => {
    const { runId } = await start([transform("a", 1), loop("each", "{{ trigger.body.list }}", [transform("t", "{{ loop.item }}")]), transform("b", 2)], {
      body: { list: [1, 2] },
    });
    await c.runs.updateOne({ _id: runId }, { $unset: { stepRuns: "" } });
    expect(await load(runId)).not.toHaveProperty("stepRuns");
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("succeeded");
    expect(run.outputs).toMatchObject({ a: 1, t: 2, b: 2 });
  });

  it("carries on an older flat run from its saved step index", async () => {
    const { runId } = await start([transform("a", 1), transform("b", "{{ steps.a }}+1"), transform("c", 3)]);
    // As a run from before blocks would have been left after its first step.
    await c.runs.updateOne({ _id: runId }, { $set: { stepIndex: 1, outputs: { a: 1 }, outputBytes: 1, status: "waiting", nextRunAt: 0 }, $unset: { stepRuns: "" } });
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("succeeded");
    expect(run.logs.map((l) => l.stepId)).toEqual(["b", "c"]);
    expect(run.outputs).toEqual({ a: 1, b: "1+1", c: 3 });
  });

  // ---------- secrets ----------

  const SECRET = 'sk_"live"_9f8e7d6c5b4a';
  const escaped = JSON.stringify(SECRET).slice(1, -1);

  async function secret(ws: string, owner: string, name: string, value: string) {
    await c.workspaces.updateOne({ _id: ws }, { $setOnInsert: { ownerId: owner, name: ws, personal: false, createdAt: 1 } }, { upsert: true });
    const res = await putSecret(c, PEPPER, ws, owner, name, value, Date.now());
    expect(res).toMatchObject({ name });
  }

  it("renders a secret into steps and hides its value in outputs, logs and later steps", async () => {
    const ws = `ws_sec_${++n}`;
    const owner = `usr_sec_${n}`;
    await secret(ws, owner, "API_KEY", SECRET);
    await secret(ws, owner, "UNUSED_KEY", "never-loaded-value");
    const { runId } = await start(
      [
        transform("show", { raw: "{{ secrets.API_KEY }}", text: "key={{ secrets.API_KEY }}", all: "dump {{ secrets }}" }),
        log("say", "using {{ secrets.API_KEY }}"),
        ifStep("check", "{{ secrets.API_KEY }}", "equals", "{{ secrets.API_KEY }}", [transform("matched", "{{ steps.show.raw }}")]),
      ],
      { body: {} },
      ws,
      owner,
    );
    await advance(c, runId, PEPPER);
    const run = await load(runId);
    expect(run.status).toBe("succeeded");
    // The value really was rendered (the if compared it and took then) ...
    expect(run.outputs.check).toEqual({ result: true, branch: "then" });
    // ... but what was stored shows only the name, in plain and in JSON text.
    expect(run.outputs.show).toEqual({
      raw: "[secret API_KEY]",
      text: "key=[secret API_KEY]",
      // Only the secrets the run names are loaded.
      all: 'dump {"API_KEY":"[secret API_KEY]"}',
    });
    expect(run.logs.find((l) => l.stepId === "say")?.message).toBe("using [secret API_KEY]");
    // A later step reading an earlier output gets the hidden form.
    expect(run.outputs.matched).toBe("[secret API_KEY]");
    const stored = JSON.stringify(run);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain(escaped);
    expect(stored).not.toContain("9f8e7d6c5b4a");
    expect(stored).not.toContain("never-loaded-value");
  });

  it("hides a secret in the run's error and its failed log line", async () => {
    const ws = `ws_sec_${++n}`;
    const owner = `usr_sec_${n}`;
    await secret(ws, owner, "BAD_URL", "not a url 4f3e2d1c");
    const { runId } = await start([http("call", "{{ secrets.BAD_URL }}")], { body: {} }, ws, owner);
    await advance(c, runId, PEPPER);
    const run = await load(runId);
    expect(run.status).toBe("failed");
    expect(run.error).toBe('call: "[secret BAD_URL]" is not a valid URL');
    expect(run.logs[0].message).toBe('"[secret BAD_URL]" is not a valid URL');
    expect(JSON.stringify(run)).not.toContain("4f3e2d1c");
  });

  it("hides a secret in a filter's stop message", async () => {
    const ws = `ws_sec_${++n}`;
    const owner = `usr_sec_${n}`;
    await secret(ws, owner, "TOKEN", "tok_abcdef123456");
    const { runId } = await start([filter("gate", "{{ secrets.TOKEN }}", "equals", "something else")], { body: {} }, ws, owner);
    await advance(c, runId, PEPPER);
    const run = await load(runId);
    expect(run.status).toBe("stopped");
    expect(run.logs[0].message).toContain("[secret TOKEN]");
    expect(JSON.stringify(run)).not.toContain("tok_abcdef123456");
  });

  it("fails a step that names a secret that isn't set, saying which", async () => {
    const { runId } = await start([transform("ok", 1), transform("needs", "{{ secrets.NOT_SET_ANYWHERE }}"), transform("after", 2)]);
    await advance(c, runId, PEPPER);
    const run = await load(runId);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/NOT_SET_ANYWHERE/);
    expect(run.outputs).toEqual({ ok: 1 });
  });

  it("never uses another workspace's secret", async () => {
    await secret("ws_sec_owner", "usr_sec_owner", "SHARED_NAME", "belongs-to-another-workspace");
    const { runId } = await start([transform("steal", "{{ secrets.SHARED_NAME }}")], { body: {} }, `ws_sec_${++n}`, "usr_sec_owner");
    await advance(c, runId, PEPPER);
    const run = await load(runId);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/SHARED_NAME/);
    expect(JSON.stringify(run)).not.toContain("belongs-to-another-workspace");
  });

  it("can't decrypt secrets with another pepper or none, and the step fails instead", async () => {
    const ws = `ws_sec_${++n}`;
    const owner = `usr_sec_${n}`;
    await secret(ws, owner, "API_KEY", "pepper-bound-value");
    for (const pepper of ["another-pepper-0123456789", ""]) {
      const { runId } = await start([transform("t", "{{ secrets.API_KEY }}")], { body: {} }, ws, owner);
      await advance(c, runId, pepper);
      const run = await load(runId);
      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/API_KEY/);
    }
    expect(await loadSecrets(c, PEPPER, ws, ["API_KEY"])).toEqual({ API_KEY: "pepper-bound-value" });
  });

  it("stores only ciphertext, and refuses a value moved to another name or workspace", async () => {
    const ws = `ws_sec_${++n}`;
    const owner = `usr_sec_${n}`;
    await secret(ws, owner, "API_KEY", "moveable-value-123");
    const doc = await c.secrets.findOne({ _id: `${ws}:API_KEY` });
    expect(doc).toMatchObject({ workspaceId: ws, ownerId: owner, name: "API_KEY" });
    expect(JSON.stringify(doc)).not.toContain("moveable-value-123");

    // Copied under another name in the same workspace.
    await c.secrets.insertOne({ ...doc!, _id: `${ws}:MOVED`, name: "MOVED" });
    // Copied to another workspace under the same name.
    await c.workspaces.insertOne({ _id: `${ws}_other`, ownerId: owner, name: "other", personal: false, createdAt: 1 });
    await c.secrets.insertOne({ ...doc!, _id: `${ws}_other:API_KEY`, workspaceId: `${ws}_other` });

    expect(await loadSecrets(c, PEPPER, ws, ["API_KEY", "MOVED"])).toEqual({ API_KEY: "moveable-value-123" });
    expect(await loadSecrets(c, PEPPER, `${ws}_other`, ["API_KEY"])).toEqual({});
  });

  it("replaces a secret's value in place, and refuses a short pepper", async () => {
    const ws = `ws_sec_${++n}`;
    const owner = `usr_sec_${n}`;
    await secret(ws, owner, "API_KEY", "first-value-123");
    await secret(ws, owner, "API_KEY", "second-value-456");
    expect(await c.secrets.countDocuments({ workspaceId: ws })).toBe(1);
    expect(await loadSecrets(c, PEPPER, ws, ["API_KEY"])).toEqual({ API_KEY: "second-value-456" });
    await expect(putSecret(c, "short", ws, owner, "OTHER", "some-value-1", Date.now())).rejects.toThrow(/AUTH_PEPPER/);
  });

  it("refuses a secret for a workspace that doesn't exist", async () => {
    expect(await putSecret(c, PEPPER, "ws_nowhere", "usr_x", "API_KEY", "some-value-1", Date.now())).toBe("gone");
    expect(await c.secrets.countDocuments({ workspaceId: "ws_nowhere" })).toBe(0);
  });

  // ---------- secrets on their way out ----------

  /** Runs `work` with `fetch` answered by `answer`, and returns the requests that were made. */
  async function withFetch(answer: (url: string, init: RequestInit) => Response, work: () => Promise<void>) {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body });
      return answer(url, init);
    }) as typeof fetch;
    try {
      await work();
    } finally {
      globalThis.fetch = real;
    }
    return calls;
  }
  const post = (id: string, url: string, headers: Record<string, string> = {}, body?: unknown, max = 0): Step => ({
    id,
    name: id,
    type: "http",
    retry: { max, backoffSeconds: 5 },
    config: { method: "POST", url, headers, body, failOnError: true },
  });

  it("never writes a chat webhook URL kept as a secret into the log or the error, whole or in part", async () => {
    const ws = `ws_sec_${++n}`;
    const owner = `usr_sec_${n}`;
    const url = "https://hooks.slack.example/services/T01ABCDEF/B02GHIJKL/xoxTokenValue123456";
    await secret(ws, owner, "SLACK_URL", url);
    for (const status of [200, 404]) {
      const { runId } = await start([post("say", "{{ secrets.SLACK_URL }}", {}, { text: "hi" })], { body: {} }, ws, owner);
      const calls = await withFetch(
        (to) => new Response(JSON.stringify({ echoed: to }), { status, headers: { "content-type": "application/json" } }),
        () => advance(c, runId, PEPPER),
      );
      expect(calls.map((call) => call.url)).toEqual([url]);
      const run = await load(runId);
      expect(run.status).toBe(status === 200 ? "succeeded" : "failed");
      expect(run.logs[0].message).toBe(`POST [secret SLACK_URL] → ${status}`);
      const stored = JSON.stringify(run);
      for (const part of ["xoxTokenValue123456", "T01ABCDEF", "hooks.slack.example"]) expect(stored).not.toContain(part);
    }
  });

  it("shows where a request went with only the secret part hidden", async () => {
    const ws = `ws_sec_${++n}`;
    const owner = `usr_sec_${n}`;
    await secret(ws, owner, "BOT_TOKEN", "123456:AAbotTokenValue");
    const { runId } = await start([post("say", "https://api.chat.example/bot{{ secrets.BOT_TOKEN }}/send")], { body: {} }, ws, owner);
    await withFetch(() => new Response("ok"), () => advance(c, runId, PEPPER));
    const run = await load(runId);
    expect(run.logs[0].message).toBe("POST api.chat.example/bot[secret BOT_TOKEN]/send → 200");
    expect(JSON.stringify(run)).not.toContain("AAbotTokenValue");
  });

  it("doesn't leave the start of a long secret in an if's or a filter's log line", async () => {
    const ws = `ws_sec_${++n}`;
    const owner = `usr_sec_${n}`;
    const long = `eyJ${"aB3dE6gH9".repeat(60)}`;
    await secret(ws, owner, "API_JWT", long);
    const { runId } = await start(
      [
        ifStep("check", "{{ trigger.body.token }}", "equals", "{{ secrets.API_JWT }}", [transform("in", 1)]),
        filter("gate", "{{ secrets.API_JWT }}", "equals", "guess"),
      ],
      { body: { token: "guess" } },
      ws,
      owner,
    );
    await advance(c, runId, PEPPER);
    const run = await load(runId);
    expect(run.logs.map((l) => l.message)).toEqual([
      'False: "guess" equals "[secret API_JWT]". Else is empty',
      'Stopped: "[secret API_JWT]" equals "guess" is false',
    ]);
    expect(JSON.stringify(run)).not.toContain(long.slice(0, 20));
  });

  it("hides a secret that a service echoes back without the spaces around it", async () => {
    const { redactor } = await import("../worker/secrets");
    const clean = redactor({ TOKEN: " tok_live_abcdef123456\t" });
    expect(clean("Bearer tok_live_abcdef123456")).toBe("Bearer [secret TOKEN]");
    const hook = redactor({ HOOK: "https://Discord.example:443/api/webhooks/1234/AbCdEfGh" });
    expect(hook("POST discord.example/api/webhooks/1234/AbCdEfGh → 404")).toBe("POST [secret HOOK] → 404");
    expect(hook("see /api/webhooks/1234/AbCdEfGh")).toBe("see [secret HOOK]");
  });

  it("doesn't pass a secret on when the service redirects to another site", async () => {
    const ws = `ws_sec_${++n}`;
    const owner = `usr_sec_${n}`;
    await secret(ws, owner, "TOKEN", "tok_live_abcdef123456");
    const answer = (to: string) =>
      to.startsWith("https://good.example") ? new Response(null, { status: 307, headers: { location: "https://other.example/in" } }) : new Response("ok");

    // In a header that isn't one of the usual credential headers: dropped, the request goes on.
    let started = await start([post("call", "https://good.example/a", { "x-auth-token": "{{ secrets.TOKEN }}", "x-plain": "1" })], { body: {} }, ws, owner);
    let calls = await withFetch(answer, () => advance(c, started.runId, PEPPER));
    expect(calls.map((call) => [call.url, call.headers["x-auth-token"], call.headers["x-plain"]])).toEqual([
      ["https://good.example/a", "tok_live_abcdef123456", "1"],
      ["https://other.example/in", undefined, "1"],
    ]);

    // In the body, which a 307 would send again: the step fails instead.
    started = await start([post("call", "https://good.example/a", {}, { key: "{{ secrets.TOKEN }}" })], { body: {} }, ws, owner);
    calls = await withFetch(answer, () => advance(c, started.runId, PEPPER));
    expect(calls.map((call) => call.url)).toEqual(["https://good.example/a"]);
    const run = await load(started.runId);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/redirected to other\.example; the body holds a secret/);
  });

  it("says so when a saved secret can't be read any more, instead of calling it missing", async () => {
    const ws = `ws_sec_${++n}`;
    const owner = `usr_sec_${n}`;
    await secret(ws, owner, "API_KEY", "value-under-old-pepper");
    const { runId } = await start([transform("needs", "{{ secrets.API_KEY }}")], { body: {} }, ws, owner);
    await advance(c, runId, "another-pepper-0123456789abcdef");
    expect((await load(runId)).error).toMatch(/API_KEY is saved but can't be read any more/);
  });

  // ---------- requests and limits ----------

  it("counts every retry as a step run", async () => {
    const { runId } = await start([post("call", "https://flaky.example/a", {}, undefined, 2)]);
    await withFetch(() => new Response("no", { status: 500 }), async () => {
      await advance(c, runId);
      await resume(runId);
      await resume(runId);
    });
    const run = await load(runId);
    expect(run.status).toBe("failed");
    expect(run.stepRuns).toBe(3);
  });

  it("steps aside after 30 requests in one go and carries on from the same item", async () => {
    const list = Array.from({ length: 35 }, (_, i) => i);
    const { runId } = await start([loop("each", "{{ trigger.body.list }}", [post("call", "https://api.example/item/{{ loop.item }}")])], { body: { list } });
    const calls = await withFetch(() => new Response("ok"), async () => {
      await advance(c, runId);
      const parked = await load(runId);
      expect(parked.status).toBe("waiting");
      expect(parked.error).toMatch(/as many requests as fit in one go/);
      expect(parked.outputs.each).toMatchObject({ index: LIMITS.httpCallsPerGo, count: 35 });
      await resume(runId);
    });
    const run = await load(runId);
    expect([run.status, run.error]).toEqual(["succeeded", null]);
    expect(calls.map((call) => call.url)).toEqual(list.map((i) => `https://api.example/item/${i}`));
  });

  it("saves a request in a loop once per pass, the loop's move with it", async () => {
    const list = Array.from({ length: 20 }, (_, i) => i);
    const { runId } = await start([loop("each", "{{ trigger.body.list }}", [post("call", "https://api.example/item/{{ loop.item }}")])], { body: { list } });
    const real = c.runs.updateOne.bind(c.runs);
    let writes = 0;
    c.runs.updateOne = ((...args: Parameters<typeof real>) => (writes++, real(...args))) as typeof real;
    const calls = await withFetch(() => new Response("ok"), async () => {
      try {
        await advance(c, runId);
      } finally {
        c.runs.updateOne = real;
      }
    });
    const run = await load(runId);
    expect(run.status).toBe("succeeded");
    expect(calls.length).toBe(20);
    expect(run.outputs.each).toEqual({ count: 20 });
    // One save per request, plus the claim, the loop's start and the finish. It was two per request.
    expect(writes).toBeLessThan(20 + 8);
  });

  it("gives the same result when the Worker stops at any save and the run is picked up again", async () => {
    const list = Array.from({ length: 12 }, (_, i) => i);
    const steps = [
      loop("each", "{{ trigger.body.list }}", [
        transform("double", "{{ loop.item }}"),
        ifStep("third", "{{ loop.index }}", "equals", "3", [http("call", "https://api.example/item/{{ loop.item }}")]),
        log("say", "item {{ loop.item }}"),
      ]),
      transform("after", "{{ steps.each.count }}"),
    ];
    const shape = (run: RunDoc) => ({
      status: run.status,
      outputs: run.outputs,
      outputBytes: run.outputBytes,
      stepRuns: run.stepRuns,
      stepIndex: run.stepIndex,
      logs: run.logs.map((l) => [l.stepId, l.status, l.message]),
    });
    const real = c.runs.updateOne.bind(c.runs);
    /** Runs the workflow, stopping at write number `dieAt` (before or after it lands), then picks it up again. */
    async function go(dieAt: number, landed: boolean) {
      const { runId } = await start(steps, { body: { list } });
      let writes = 0;
      c.runs.updateOne = (async (...args: Parameters<typeof real>) => {
        writes += 1;
        if (dieAt === 0 || writes < dieAt) return real(...args);
        // From here on the Worker is gone: nothing it tries to write arrives, not even "this run failed".
        if (writes === dieAt && landed) await real(...args);
        throw new Error("the Worker stopped");
      }) as typeof real;
      let calls: unknown[] = [];
      try {
        calls = await withFetch(() => new Response("ok"), async () => {
          const errors = vi.spyOn(console, "error").mockImplementation(() => {});
          await advance(c, runId);
          errors.mockRestore();
          c.runs.updateOne = real;
          // The lease of the stopped invocation runs out, and the cron picks the run up.
          await c.runs.updateOne({ _id: runId, status: "running" }, { $set: { leaseUntil: 0 } });
          await advance(c, runId);
        });
      } finally {
        c.runs.updateOne = real;
      }
      return { run: await load(runId), writes, calls: calls.length };
    }
    const clean = await go(0, false);
    expect(clean.run.status).toBe("succeeded");
    expect(clean.run.stepRuns).toBe(1 + 12 * 3 + 1 + 1);
    expect(clean.calls).toBe(1);
    for (let at = 1; at <= clean.writes; at++) {
      for (const landed of [false, true]) {
        const crashed = await go(at, landed);
        expect(shape(crashed.run), `stopped at write ${at}, ${landed ? "after" : "before"} it landed`).toEqual(shape(clean.run));
        // The request is made once; only a stop on the save right after it can repeat it, and then once.
        expect(crashed.calls).toBeGreaterThanOrEqual(1);
        expect(crashed.calls).toBeLessThanOrEqual(2);
      }
    }
  }, 120_000);

  it("shares one request allowance between the runs woken together", async () => {
    const list = Array.from({ length: 25 }, (_, i) => i);
    const steps = [loop("each", "{{ trigger.body.list }}", [post("call", "https://api.example/x")])];
    const a = await start(steps, { body: { list } });
    const b = await start(steps, { body: { list } });
    const shared = { calls: 40 };
    const calls = await withFetch(() => new Response("ok"), async () => {
      await advance(c, a.runId, "", shared);
      await advance(c, b.runId, "", shared);
    });
    expect(calls.length).toBe(40);
    expect((await load(a.runId)).status).toBe("succeeded");
    expect((await load(b.runId)).status).toBe("waiting");
  });

  it("charges a cut-off output what it really stores, so rewriting it can't hide other outputs", async () => {
    const { keepable } = await import("../worker/engine");
    const kept = keepable('"'.repeat(20_000));
    expect(kept.value).toMatchObject({ truncated: true });
    const stored = new TextEncoder().encode(JSON.stringify(kept.value)).byteLength;
    expect(stored).toBeLessThanOrEqual(16_000 + 40);
    expect(kept.bytes).toBe(stored);
  });

  // ---------- round 2 ----------

  it("doesn't take a step's own words for the platform's request limit", async () => {
    // Text the author controls ends up in these messages; it must fail like any other step.
    const shared = { calls: 40 };
    for (const url of ["too many subrequests", "https://x.example/Too many subrequests"]) {
      const { runId } = await start([post("call", url)]);
      await withFetch(() => new Response("no", { status: 500 }), () => advance(c, runId, "", shared));
      const run = await load(runId);
      expect([run.status, run.stepRuns]).toEqual(["failed", 1]);
    }
    expect(shared.calls).toBe(39);
  });

  it("parks when the platform itself refuses another request, and counts the try", async () => {
    const shared = { calls: 40 };
    const { runId } = await start([post("call", "https://api.example/a")]);
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Too many subrequests.");
    }) as typeof fetch;
    try {
      await advance(c, runId, "", shared);
    } finally {
      globalThis.fetch = real;
    }
    const run = await load(runId);
    expect([run.status, run.stepRuns, run.attempt]).toEqual(["waiting", 1, 0]);
    expect(run.error).toMatch(/Knotwork made as many requests as fit in this minute/);
    expect(shared.calls).toBe(0);
  });

  it("keeps one run to its own 30 requests even when the tick has more left, and counts redirects", async () => {
    const list = Array.from({ length: 45 }, (_, i) => i);
    const a = await start([loop("each", "{{ trigger.body.list }}", [post("call", "https://api.example/x")])], { body: { list } });
    const shared = { calls: 40 };
    let calls = await withFetch(() => new Response("ok"), () => advance(c, a.runId, "", shared));
    expect(calls.length).toBe(LIMITS.httpCallsPerGo);
    expect(shared.calls).toBe(10);
    expect((await load(a.runId)).error).toMatch(/this run made as many requests/);

    // Each call here is two requests: the redirect and where it leads.
    const b = await start([loop("each", "{{ trigger.body.list }}", [post("call", "https://hop.example/x")])], { body: { list } });
    calls = await withFetch(
      (to) => (to.startsWith("https://hop.example/x") ? new Response(null, { status: 302, headers: { location: "https://hop.example/y" } }) : new Response("ok")),
      () => advance(c, b.runId),
    );
    expect(calls.length).toBe(LIMITS.httpCallsPerGo);
    expect((await load(b.runId)).outputs.each).toMatchObject({ index: LIMITS.httpCallsPerGo / 2 });
  });

  it("names the host the request really went to", async () => {
    const { runId } = await start([post("call", "https://evil.example.net\\@api.github.example/repos")]);
    const calls = await withFetch(() => new Response("ok"), () => advance(c, runId));
    expect(new URL(calls[0].url).host).toBe("evil.example.net");
    expect((await load(runId)).logs[0].message).toMatch(/^POST evil\.example\.net\//);
  });

  it("hides the parts of a URL secret, and a secret as a URL encodes it, when a service echoes them", async () => {
    const { redactor } = await import("../worker/secrets");
    const hook = redactor({ HOOK: "https://user:Passw0rdValue@Chat.Example.COM:8443/v1/spaces/AAAA/messages?key=QUERYKEY12345678&token=tok-abcdefgh" });
    expect(hook({ args: { key: "QUERYKEY12345678", token: "tok-abcdefgh" } })).toEqual({ args: { key: "[secret HOOK]", token: "[secret HOOK]" } });
    expect(hook("failed (?key=QUERYKEY12345678&token=tok-abcdefgh)")).toBe("failed (?[secret HOOK])");
    expect(hook("auth Passw0rdValue")).toBe("auth [secret HOOK]");
    const odd = redactor({ A: "ab|cd ef[1]", B: "it's a secret", HOST: "Api.Internal-Name.example" });
    expect(odd("https://x.example/ab|cd%20ef[1]/send?k=it%27s%20a%20secret")).toBe("https://x.example/[secret A]/send?k=[secret B]");
    expect(odd("called api.internal-name.example")).toBe("called [secret HOST]");
  });
});
