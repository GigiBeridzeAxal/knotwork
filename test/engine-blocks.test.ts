import { type Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    // The loop's start, 3 passes of 2 steps, 3 moves to the next item (the last one ends the loop), and "after".
    expect(run.stepRuns).toBe(1 + 3 * 2 + 3 + 1);
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
    expect(run.outputs.t).toBe("a");
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
    expect(run.outputs.after_wait).toBe(1);
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

  it("allows a run exactly 200 step runs, counting every pass and every move to the next item", async () => {
    // 1 + 1 + 33 × (5 steps + 1 move) = 200.
    const inner = ["s1", "s2", "s3", "s4", "s5"].map((id) => transform(id, "{{ loop.index }}"));
    const list = Array.from({ length: 33 }, (_, i) => i);
    const { runId } = await start([transform("first", 1), loop("each", "{{ trigger.body.list }}", inner)], { body: { list } });
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("succeeded");
    expect(run.stepRuns).toBe(LIMITS.stepRunsPerRun);
  });

  it("fails a run once it has taken 200 step runs", async () => {
    // 1 + 50 × (3 steps + 1 move) = 201: the last move to the end is one too many.
    const inner = ["s1", "s2", "s3"].map((id) => transform(id, "{{ loop.index }}"));
    const list = Array.from({ length: 50 }, (_, i) => i);
    const { runId } = await start([loop("each", "{{ trigger.body.list }}", inner), transform("after", 1)], { body: { list } });
    await advance(c, runId);
    const run = await load(runId);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/reached 200 steps/);
    expect(run.stepRuns).toBe(LIMITS.stepRunsPerRun);
    expect(run.outputs.s3).toBe(49);
    expect(run.outputs).not.toHaveProperty("after");
    expect(run.logs.at(-1)).toMatchObject({ stepId: "each", status: "failed" });
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
    expect(run.outputs).toMatchObject({ high: "50 is big", low: "7 is small", seen: "else" });
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
});
