import type { IfStep, LeafStep, LoopStep, Step } from "../shared/schema";

/**
 * A workflow's steps are a tree (an `if` or a `loop` holds steps), but a run saves its place as one
 * number. So the tree is flattened into a list of operations with jumps, and that number is an index
 * into the list. A workflow without blocks flattens to its own steps in order, so the index means what
 * it always did. Flattening is pure and cheap, so it is done again each time a run moves; only the
 * index is stored.
 *
 *   if    → [if] then… [jump] else…        `if` goes on, or jumps to `elseAt`; `jump` skips the else
 *   loop  → [loop] steps… [next]           `loop` reads the list (empty: jumps to `endAt`);
 *                                          `next` takes the next item and jumps back to `bodyAt`
 */
export type Op =
  | { kind: "step"; step: LeafStep; loops: string[]; depth: number }
  | { kind: "if"; step: IfStep; elseAt: number; loops: string[]; depth: number }
  | { kind: "jump"; to: number }
  | { kind: "loop"; step: LoopStep; endAt: number; loops: string[]; depth: number }
  | { kind: "next"; step: LoopStep; bodyAt: number; loops: string[]; depth: number };

/** `loops` on an op are the ids of the loops it runs inside, outermost first; `depth` counts all blocks. */
export function compile(steps: Step[]): Op[] {
  const ops: Op[] = [];
  const add = (list: Step[], loops: string[], depth: number) => {
    for (const step of list) {
      if (step.type === "if") {
        const branch: Extract<Op, { kind: "if" }> = { kind: "if", step, elseAt: 0, loops, depth };
        ops.push(branch);
        add(step.then, loops, depth + 1);
        const skip: Extract<Op, { kind: "jump" }> = { kind: "jump", to: 0 };
        ops.push(skip);
        branch.elseAt = ops.length;
        add(step.else, loops, depth + 1);
        skip.to = ops.length;
      } else if (step.type === "loop") {
        const start: Extract<Op, { kind: "loop" }> = { kind: "loop", step, endAt: 0, loops, depth };
        ops.push(start);
        const bodyAt = ops.length;
        add(step.steps, [...loops, step.id], depth + 1);
        ops.push({ kind: "next", step, bodyAt, loops, depth });
        start.endAt = ops.length;
      } else {
        ops.push({ kind: "step", step, loops, depth });
      }
    }
  };
  add(steps, [], 0);
  return ops;
}
