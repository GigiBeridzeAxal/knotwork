import { describe, expect, it } from "vitest";
import type { Step } from "../shared/schema";
import {
  allIds,
  branchesOf,
  countSteps,
  flatten,
  getStep,
  insertStep,
  issueStep,
  moveStep,
  refsFor,
  removeStep,
  replaceStep,
  withoutChildren,
} from "../shared/tree";

const retry = { max: 0, backoffSeconds: 5 };
const log = (id: string) => ({ id, name: id, type: "log", retry, config: { message: id } }) as Step;
// Blocks as the branching work defines them: child lists sit on the step itself.
const when = (id: string, then: Step[], otherwise: Step[]) =>
  ({ id, name: id, type: "if", retry, config: { left: "1", op: "equals", right: "1" }, then, else: otherwise }) as unknown as Step;
const loop = (id: string, steps: Step[]) => ({ id, name: id, type: "loop", retry, config: { items: "{{ trigger.body }}" }, steps }) as unknown as Step;

const ids = (steps: Step[]) => allIds(steps).join(" ");

/** a, check(then: b, each(c, d); else: e), f */
const tree = () => [log("a"), when("check", [log("b"), loop("each", [log("c"), log("d")])], [log("e")]), log("f")];

describe("step tree", () => {
  it("lists a block's branches in drawing order, and none for an ordinary step", () => {
    expect(branchesOf(log("a"))).toEqual([]);
    expect(branchesOf(tree()[1]).map((b) => b.key)).toEqual(["then", "else"]);
    expect(branchesOf(loop("l", [])).map((b) => b.label)).toEqual(["For each item"]);
  });

  it("walks every step, blocks before what they hold", () => {
    expect(ids(tree())).toBe("a check b each c d e f");
    expect(countSteps(tree())).toBe(8);
    expect(flatten(tree()).find((p) => p.step.id === "d")).toMatchObject({ path: [1, "then", 1, "steps", 1], depth: 2 });
  });

  it("finds a step by path, and nothing for a path that leads nowhere", () => {
    expect(getStep(tree(), [1, "then", 1, "steps", 0])?.id).toBe("c");
    expect(getStep(tree(), [1, "else", 0])?.id).toBe("e");
    expect(getStep(tree(), [0, "then", 0])).toBeNull();
    expect(getStep(tree(), [9])).toBeNull();
    expect(getStep(tree(), [])).toBeNull();
  });

  it("inserts, replaces and removes without changing the tree it was given", () => {
    const before = tree();
    const snapshot = JSON.stringify(before);
    expect(ids(insertStep(before, [1, "else", 0], log("x")))).toBe("a check b each c d x e f");
    expect(ids(insertStep(before, [3], log("x")))).toBe("a check b each c d e f x");
    expect(ids(insertStep(before, [1, "then", 1, "steps", 2], log("x")))).toBe("a check b each c d x e f");
    expect(ids(replaceStep(before, [1, "then", 0], log("x")))).toBe("a check x each c d e f");
    expect(ids(removeStep(before, [1, "then", 1]))).toBe("a check b e f");
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("moves a step within a list, counting the gap it leaves", () => {
    const flat = [log("a"), log("b"), log("c")];
    expect(ids(moveStep(flat, [0], [3])!.steps)).toBe("b c a");
    expect(moveStep(flat, [0], [3])!.path).toEqual([2]);
    expect(ids(moveStep(flat, [2], [0])!.steps)).toBe("c a b");
    expect(ids(moveStep(flat, [0], [2])!.steps)).toBe("b a c");
  });

  it("refuses moves that change nothing or put a block inside itself", () => {
    expect(moveStep(tree(), [0], [0])).toBeNull();
    expect(moveStep(tree(), [0], [1])).toBeNull();
    expect(moveStep(tree(), [1], [1, "then", 0])).toBeNull();
    expect(moveStep(tree(), [1], [1, "then", 1, "steps", 0])).toBeNull();
    expect(moveStep(tree(), [9], [0])).toBeNull();
    expect(moveStep(tree(), [0], [0, "then", 0])).toBeNull();
  });

  it("moves a step into and out of a block", () => {
    const into = moveStep(tree(), [0], [1, "else", 1])!;
    expect(ids(into.steps)).toBe("check b each c d e a f");
    // "a" left the top level, so the block is now first.
    expect(into.path).toEqual([0, "else", 1]);
    expect(getStep(into.steps, into.path)?.id).toBe("a");

    const out = moveStep(tree(), [1, "then", 1, "steps", 0], [0])!;
    expect(ids(out.steps)).toBe("c a check b each d e f");
    expect(out.path).toEqual([0]);

    const across = moveStep(tree(), [1, "then", 0], [1, "else", 0])!;
    expect(ids(across.steps)).toBe("a check each c d b e f");
    expect(getStep(across.steps, across.path)?.id).toBe("b");
  });

  it("moves a whole block with what it holds", () => {
    const moved = moveStep(tree(), [1, "then", 1], [3])!;
    expect(ids(moved.steps)).toBe("a check b e f each c d");
    expect(getStep(moved.steps, [3, "steps", 1])?.id).toBe("d");
  });

  it("offers only steps that have finished before this one, and the loop it sits in", () => {
    expect(refsFor(tree(), [0])).toEqual(["trigger.body", "run.id", "workflow.name"]);
    expect(refsFor(tree(), [2])).toEqual(["trigger.body", "steps.a", "steps.check", "run.id", "workflow.name"]);
    // Inside the loop: "a" (before the if), "b" (before the loop), "c" (before it in the loop). Not "e": the other branch.
    expect(refsFor(tree(), [1, "then", 1, "steps", 1])).toEqual([
      "trigger.body", "steps.a", "steps.b", "steps.c", "loop.item", "loop.index", "run.id", "workflow.name",
    ]);
    expect(refsFor(tree(), [1, "else", 0])).toEqual(["trigger.body", "steps.a", "run.id", "workflow.name"]);
  });

  it("empties a block's lists, and leaves an ordinary step as it is", () => {
    expect(branchesOf(withoutChildren(tree()[1])).map((b) => b.steps.length)).toEqual([0, 0]);
    expect(withoutChildren(log("a"))).toEqual(log("a"));
  });

  it("maps a validation issue to its step and field", () => {
    expect(issueStep(["steps", 2, "config", "url"])).toEqual({ path: [2], field: "config.url" });
    expect(issueStep(["steps", 1, "then", 0, "id"])).toEqual({ path: [1, "then", 0], field: "id" });
    expect(issueStep(["steps", 1, "then", 1, "steps", 0, "name"])).toEqual({ path: [1, "then", 1, "steps", 0], field: "name" });
    expect(issueStep(["steps", 1])).toEqual({ path: [1], field: "" });
    expect(issueStep(["name"])).toBeNull();
    expect(issueStep(["steps"])).toBeNull();
  });

  it("refuses a move that would put a step deeper than a workflow allows", () => {
    const leaf = (id: string) => ({ id, name: id, type: "log", config: { message: "" }, retry: { retries: 0, backoffSeconds: 1 } }) as unknown as Step;
    const loopOf = (id: string, steps: Step[]) => ({ id, name: id, type: "loop", config: { items: "" }, steps, retry: { retries: 0, backoffSeconds: 1 } }) as unknown as Step;
    const tree = [loopOf("l1", [loopOf("l2", [loopOf("l3", [])])]), leaf("x"), loopOf("box", [leaf("y")])];
    // Level 3 takes a plain step, level 4 takes nothing, and a block with steps doesn't fit at level 3.
    expect(moveStep(tree, [1], [0, "steps", 0, "steps", 0])).not.toBeNull();
    expect(moveStep(tree, [1], [0, "steps", 0, "steps", 0, "steps", 0])).toBeNull();
    expect(moveStep(tree, [2], [0, "steps", 0, "steps", 0])).toBeNull();
    expect(moveStep(tree, [2], [0, "steps", 0])).not.toBeNull();
    // An empty block doesn't fit at level 3 either: it could never be given a step there.
    expect(moveStep([...tree, loopOf("empty", [])], [3], [0, "steps", 0, "steps", 0])).toBeNull();
  });
});
