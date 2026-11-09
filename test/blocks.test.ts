import { describe, expect, it } from "vitest";
import { LIMITS } from "../shared/limits";
import { type IfStep, type LoopStep, type Step, childLists, secretInput, secretName, triggerSchema, walkSteps, workflowInput } from "../shared/schema";
import { compile } from "../worker/program";
import { evaluateIf, loopItems, type Scope } from "../worker/steps";

/** If and loop blocks without a database: flattening, validation, conditions and loop lists. */

const retry = { max: 0, backoffSeconds: 5 };
const t = (id: string): Step => ({ id, name: id, type: "transform", retry, config: { output: id } });
const ifs = (id: string, then: Step[], otherwise: Step[] = [], config: IfStep["config"] = { left: "{{ trigger.body.n }}", op: "gt", right: "1" }): IfStep => ({
  id,
  name: id,
  type: "if",
  retry,
  config,
  then,
  else: otherwise,
});
const loop = (id: string, steps: Step[], items = "{{ trigger.body.list }}"): LoopStep => ({ id, name: id, type: "loop", retry, config: { items }, steps });

const scope = (trigger: unknown): Scope => ({
  trigger,
  steps: {},
  run: { id: "run_1", startedAt: "" },
  workflow: { id: "wf_1", name: "Test" },
  secrets: {},
});

const wf = (steps: unknown[]) => workflowInput.safeParse({ name: "x", trigger: { type: "manual" }, steps });

describe("compile", () => {
  it("compiles flat steps to one step op each, in order, so old step indexes stay valid", () => {
    const ops = compile([t("a"), t("b"), t("c")]);
    expect(ops.map((op) => op.kind)).toEqual(["step", "step", "step"]);
    expect(ops.map((op) => (op.kind === "step" ? op.step.id : null))).toEqual(["a", "b", "c"]);
    expect(ops.every((op) => op.kind === "step" && op.depth === 0 && op.loops.length === 0)).toBe(true);
  });

  it("compiles an empty workflow to nothing", () => {
    expect(compile([])).toEqual([]);
  });

  it("lays out an if with a loop in its else branch, with the right jumps", () => {
    const ops = compile([t("a"), ifs("check", [t("b")], [t("c"), loop("each", [t("d")])]), t("e")]);
    const shape = ops.map((op) => {
      switch (op.kind) {
        case "step":
          return ["step", op.step.id, op.depth, op.loops];
        case "if":
          return ["if", op.step.id, op.depth, op.loops, op.elseAt];
        case "jump":
          return ["jump", op.to];
        case "loop":
          return ["loop", op.step.id, op.depth, op.loops, op.endAt];
        case "next":
          return ["next", op.step.id, op.depth, op.loops, op.bodyAt];
      }
    });
    expect(shape).toEqual([
      ["step", "a", 0, []],
      ["if", "check", 0, [], 4],
      ["step", "b", 1, []],
      ["jump", 8],
      ["step", "c", 1, []],
      ["loop", "each", 1, [], 8],
      ["step", "d", 2, ["each"]],
      ["next", "each", 1, [], 6],
      ["step", "e", 0, []],
    ]);
  });

  it("lays out nested loops, each inner op knowing every loop it is in", () => {
    const ops = compile([loop("outer", [loop("inner", [t("x")])])]);
    expect(ops).toMatchObject([
      { kind: "loop", step: { id: "outer" }, endAt: 5, loops: [], depth: 0 },
      { kind: "loop", step: { id: "inner" }, endAt: 4, loops: ["outer"], depth: 1 },
      { kind: "step", step: { id: "x" }, loops: ["outer", "inner"], depth: 2 },
      { kind: "next", step: { id: "inner" }, bodyAt: 2, loops: ["outer"], depth: 1 },
      { kind: "next", step: { id: "outer" }, bodyAt: 1, loops: [], depth: 0 },
    ]);
  });

  it("makes an if with empty branches jump straight past itself", () => {
    const ops = compile([ifs("empty", []), t("after")]);
    expect(ops).toMatchObject([{ kind: "if", elseAt: 2 }, { kind: "jump", to: 2 }, { kind: "step", step: { id: "after" } }]);
  });

  it("makes an empty loop's end point at the op after its next", () => {
    const ops = compile([loop("l", []), t("after")]);
    expect(ops).toMatchObject([{ kind: "loop", endAt: 2 }, { kind: "next", bodyAt: 1 }, { kind: "step", step: { id: "after" } }]);
  });
});

describe("block validation", () => {
  it("accepts an if and a loop and fills in missing branches", () => {
    const res = wf([
      { id: "check", name: "Check", type: "if", config: { left: "{{ trigger.body.n }}", op: "exists" } },
      { id: "each", name: "Each", type: "loop", config: { items: "{{ trigger.body.list }}" }, steps: [t("inner")] },
    ]);
    expect(res.success).toBe(true);
    const [check, each] = res.data!.steps;
    expect(check).toMatchObject({ type: "if", then: [], else: [], config: { right: "" } });
    expect(each).toMatchObject({ type: "loop", steps: [{ id: "inner" }] });
  });

  it("refuses an id used twice anywhere in the tree, pointing at the nested one", () => {
    const res = wf([t("a"), ifs("check", [t("b")], [loop("each", [t("a")])])]);
    expect(res.success).toBe(false);
    const issue = res.error!.issues.find((i) => i.message.includes('"a" is used twice'));
    expect(issue?.path).toEqual(["steps", 1, "else", 0, "steps", 0, "id"]);
  });

  it("refuses a block whose id repeats one of its own children", () => {
    expect(wf([loop("each", [t("each")])]).success).toBe(false);
  });

  it("counts the steps inside blocks toward the limit", () => {
    const inner = (n: number) => Array.from({ length: n }, (_, i) => t(`s${i}`));
    expect(wf([loop("each", inner(LIMITS.stepsPerWorkflow - 1))]).success).toBe(true);
    const over = wf([loop("each", inner(LIMITS.stepsPerWorkflow))]);
    expect(over.success).toBe(false);
    expect(over.error!.issues.map((i) => i.message).join(" ")).toMatch(/at most 25 steps, counting the ones inside blocks/);
  });

  it("allows three levels of steps and refuses a fourth", () => {
    expect(wf([loop("l1", [ifs("l2", [t("l3")])])]).success).toBe(true);
    // An empty block on the third level is fine too.
    expect(wf([loop("l1", [loop("l2", [loop("l3", [])])])]).success).toBe(true);
    const deep = wf([loop("l1", [loop("l2", [ifs("l3", [], [t("l4")])])])]);
    expect(deep.success).toBe(false);
    const issues = deep.error!.issues.filter((i) => i.message.includes("levels deep"));
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(["steps", 0, "steps", 0, "steps", 0, "else", 0]);
  });

  it("refuses a loop with no list and a block with an unknown child", () => {
    expect(wf([{ id: "l", name: "L", type: "loop", config: { items: "" }, steps: [] }]).success).toBe(false);
    expect(wf([{ id: "l", name: "L", type: "loop", config: {}, steps: [] }]).success).toBe(false);
    expect(wf([ifs("i", [{ id: "x", name: "X", type: "shell", config: {} } as never])]).success).toBe(false);
    expect(wf([{ id: "i", name: "I", type: "if", config: { left: "a", op: "is", right: "" } }]).success).toBe(false);
  });

  it("walks the tree parents first, with paths and depths, and lists each block's children", () => {
    const tree = [t("a"), ifs("check", [t("b")], [loop("each", [t("c")])])];
    const seen: [string, (string | number)[], number][] = [];
    walkSteps(tree, (step, path, depth) => seen.push([step.id, path, depth]));
    expect(seen).toEqual([
      ["a", ["steps", 0], 1],
      ["check", ["steps", 1], 1],
      ["b", ["steps", 1, "then", 0], 2],
      ["each", ["steps", 1, "else", 0], 2],
      ["c", ["steps", 1, "else", 0, "steps", 0], 3],
    ]);
    expect(childLists(tree[1]).map(([name, list]) => [name, list.length])).toEqual([["then", 1], ["else", 1]]);
    expect(childLists(loop("l", [t("x")])).map(([name]) => name)).toEqual(["steps"]);
    expect(childLists(t("a"))).toEqual([]);
  });
});

describe("secret and signature settings", () => {
  it("takes secret names in capitals, digits and _, up to 40 characters", () => {
    for (const ok of ["A", "SLACK_URL", "K9", "A".repeat(40)]) expect(secretName.safeParse(ok).success).toBe(true);
    for (const bad of ["", "slack", "9KEY", "_KEY", "A-B", "A B", "A".repeat(41)]) expect(secretName.safeParse(bad).success).toBe(false);
  });

  it("takes secret values of 8 to 4000 characters", () => {
    expect(secretInput.safeParse({ value: "x".repeat(7) }).success).toBe(false);
    expect(secretInput.safeParse({ value: "x".repeat(8) }).success).toBe(true);
    expect(secretInput.safeParse({ value: "x".repeat(4000) }).success).toBe(true);
    expect(secretInput.safeParse({ value: "x".repeat(4001) }).success).toBe(false);
    expect(secretInput.safeParse({}).success).toBe(false);
  });

  it("accepts a webhook that checks GitHub or Stripe signatures, and nothing else", () => {
    expect(triggerSchema.safeParse({ type: "webhook" }).success).toBe(true);
    expect(triggerSchema.safeParse({ type: "webhook", verify: { provider: "github", secret: "GH_SECRET" } }).success).toBe(true);
    expect(triggerSchema.safeParse({ type: "webhook", verify: { provider: "stripe", secret: "STRIPE_SIGNING" } }).success).toBe(true);
    expect(triggerSchema.safeParse({ type: "webhook", verify: { provider: "gitlab", secret: "X_SECRET" } }).success).toBe(false);
    expect(triggerSchema.safeParse({ type: "webhook", verify: { provider: "github", secret: "lower" } }).success).toBe(false);
    expect(triggerSchema.safeParse({ type: "webhook", verify: { provider: "github" } }).success).toBe(false);
  });
});

describe("if conditions", () => {
  it("takes then when the condition holds and says how many steps that is", () => {
    const step = ifs("check", [t("a")], [t("b"), t("c")]);
    const yes = evaluateIf(step, scope({ body: { n: 5 } }));
    expect(yes.passed).toBe(true);
    expect(yes.message).toMatch(/5 is greater than "1"/);
    expect(yes.message).toMatch(/then.*\(1 step\)/i);
    const no = evaluateIf(step, scope({ body: { n: 0 } }));
    expect(no.passed).toBe(false);
    expect(no.message).toMatch(/0 is greater than "1"/);
    expect(no.message).toMatch(/else.*\(2 steps\)/i);
  });

  it("says when the branch it takes is empty", () => {
    const step = ifs("check", [t("a")], [], { left: "{{ trigger.body.missing }}", op: "exists", right: "" });
    const res = evaluateIf(step, scope({ body: {} }));
    expect(res.passed).toBe(false);
    expect(res.message).toMatch(/nothing has a value/);
    expect(res.message).toMatch(/else is empty|else \(nothing to run\)/i);
  });

  it("uses the same comparisons as a filter", () => {
    const step = ifs("check", [], [], { left: "{{ trigger.body.tags }}", op: "contains", right: "{{ trigger.body.want }}" });
    expect(evaluateIf(step, scope({ body: { tags: ["a", "b"], want: "b" } })).passed).toBe(true);
    expect(evaluateIf(step, scope({ body: { tags: ["a", "b"], want: "c" } })).passed).toBe(false);
  });
});

describe("loop lists", () => {
  it("goes through a list the template gives", () => {
    expect(loopItems(loop("l", []), scope({ body: { list: [1, { a: 2 }, "x"] } }))).toEqual({ items: [1, { a: 2 }, "x"] });
    expect(loopItems(loop("l", []), scope({ body: { list: [] } }))).toEqual({ items: [] });
    // Whitespace around the template doesn't turn it into text.
    expect(loopItems(loop("l", [], "  {{ trigger.body.list }} "), scope({ body: { list: [1] } }))).toEqual({ items: [1] });
  });

  it("refuses anything that isn't a list, saying what it got", () => {
    const of = (list: unknown) => loopItems(loop("l", []), scope({ body: { list } }));
    expect(of({ a: 1 })).toEqual({ problem: "{{ trigger.body.list }} gave an object, not a list" });
    expect(of("[1,2]")).toEqual({ problem: "{{ trigger.body.list }} gave text, not a list" });
    expect(of(3)).toEqual({ problem: "{{ trigger.body.list }} gave a number, not a list" });
    expect(of(undefined)).toEqual({ problem: "{{ trigger.body.list }} gave nothing, not a list" });
    expect(of(null)).toEqual({ problem: "{{ trigger.body.list }} gave nothing, not a list" });
  });

  it("goes through at most 50 items and refuses a longer list instead of cutting it", () => {
    const of = (n: number) => loopItems(loop("l", []), scope({ body: { list: Array.from({ length: n }, (_, i) => i) } }));
    expect("items" in of(LIMITS.loopItems)).toBe(true);
    expect(of(LIMITS.loopItems + 1)).toEqual({ problem: "The list has 51 items, and a loop can go through at most 50" });
  });
});
