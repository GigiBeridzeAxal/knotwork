import { LIMITS } from "./limits";
import type { Step } from "./schema";

/**
 * A workflow's steps form a tree: an "if" step holds two lists (`then`, `else`) and a "loop" step
 * holds one (`steps`). The canvas, and anything else that edits steps in place, reads and changes
 * that tree through this file, so nothing else needs to know which step types hold children.
 */

export const BRANCH_KEYS = ["then", "else", "steps"] as const;
export type BranchKey = (typeof BRANCH_KEYS)[number];

const BRANCH_LABELS: Record<BranchKey, string> = { then: "If true", else: "If false", steps: "For each item" };

export interface Branch {
  key: BranchKey;
  label: string;
  steps: Step[];
}

/** The lists of steps a step holds, in the order they are drawn. Empty for an ordinary step. */
export function branchesOf(step: Step): Branch[] {
  const holder = step as unknown as Record<string, unknown>;
  const out: Branch[] = [];
  for (const key of BRANCH_KEYS) {
    const list = holder[key];
    if (Array.isArray(list)) out.push({ key, label: BRANCH_LABELS[key], steps: list as Step[] });
  }
  return out;
}

/**
 * Where something sits in the tree: a step's index, then (for a step inside a block) the name of the
 * block's list and the index in it, and so on. `[2]` is the third top-level step; `[2, "then", 0]` is
 * the first step of its "then" list. The same shape names a gap to insert into: `[2, "then", 1]` as a
 * slot means "before whatever is second in that list".
 */
export type Path = (number | BranchKey)[];

export const pathKey = (path: Path) => path.join(".");
export const samePath = (a: Path, b: Path) => a.length === b.length && a.every((part, i) => part === b[i]);
const startsWith = (path: Path, prefix: Path) => prefix.length <= path.length && prefix.every((part, i) => part === path[i]);

/** The list a path's last index points into, e.g. `[2, "then"]` for `[2, "then", 0]`. */
const listOf = (path: Path): Path => path.slice(0, -1);
const indexOf = (path: Path): number => path[path.length - 1] as number;

function childList(step: Step, key: BranchKey): Step[] | null {
  const list = (step as unknown as Record<string, unknown>)[key];
  return Array.isArray(list) ? (list as Step[]) : null;
}

/** The list at a list path (`[]` is the top level), or null when the path leads nowhere. */
export function getList(steps: Step[], listPath: Path): Step[] | null {
  let list: Step[] | null = steps;
  for (let i = 0; i < listPath.length; i += 2) {
    const step: Step | undefined = list[listPath[i] as number];
    if (!step) return null;
    list = childList(step, listPath[i + 1] as BranchKey);
    if (!list) return null;
  }
  return list;
}

export function getStep(steps: Step[], path: Path): Step | null {
  if (path.length === 0) return null;
  return getList(steps, listOf(path))?.[indexOf(path)] ?? null;
}

/** A copy of the tree with one list replaced; every list and step on the way down is copied too. */
function withList(steps: Step[], listPath: Path, change: (list: Step[]) => Step[]): Step[] {
  if (listPath.length === 0) return change(steps);
  const [index, key, ...rest] = listPath as [number, BranchKey, ...Path];
  const step = steps[index];
  const list = step && childList(step, key);
  if (!list) return steps;
  const next = [...steps];
  next[index] = { ...step, [key]: withList(list, rest, change) } as Step;
  return next;
}

export function insertStep(steps: Step[], slot: Path, step: Step): Step[] {
  return withList(steps, listOf(slot), (list) => [...list.slice(0, indexOf(slot)), step, ...list.slice(indexOf(slot))]);
}

export function removeStep(steps: Step[], path: Path): Step[] {
  return withList(steps, listOf(path), (list) => list.filter((_, i) => i !== indexOf(path)));
}

export function replaceStep(steps: Step[], path: Path, step: Step): Step[] {
  return withList(steps, listOf(path), (list) => list.map((s, i) => (i === indexOf(path) ? step : s)));
}

/**
 * Moves a step to a gap. Returns the new tree and where the step ended up, or null when the move
 * makes no sense (a block into itself) or changes nothing (the gap right before or after it).
 */
/** How deep a place is: 1 for the top level, 2 inside a block, and so on. */
export const levelOf = (path: Path) => (path.length + 1) / 2;

/** How many levels a step takes up: 1 on its own, more for a block with blocks inside. */
const heightOf = (step: Step): number => 1 + Math.max(0, ...branchesOf(step).flatMap((b) => b.steps.map(heightOf)));

export function moveStep(steps: Step[], from: Path, slot: Path): { steps: Step[]; path: Path } | null {
  const step = getStep(steps, from);
  if (!step || !getList(steps, listOf(slot))) return null;
  if (startsWith(slot, from) && slot.length > from.length) return null;
  // A block can't be dropped where the steps inside it would sit deeper than a workflow allows.
  if (levelOf(slot) + heightOf(step) - 1 > LIMITS.stepDepth) return null;
  const sameList = samePath(listOf(from), listOf(slot));
  if (sameList && (indexOf(slot) === indexOf(from) || indexOf(slot) === indexOf(from) + 1)) return null;
  // Taking the step out shifts everything after it in its own list one place up, including a target
  // that sits in, or below, a later item of that list.
  const target = [...slot];
  const depth = from.length - 1;
  if (startsWith(slot, listOf(from)) && (target[depth] as number) > indexOf(from)) target[depth] = (target[depth] as number) - 1;
  return { steps: insertStep(removeStep(steps, from), target, step), path: target };
}

export interface Placed {
  step: Step;
  path: Path;
  /** 0 for a top-level step. */
  depth: number;
}

/** Every step in the order it is drawn: a block first, then what it holds. */
export function flatten(steps: Step[], base: Path = [], depth = 0): Placed[] {
  return steps.flatMap((step, i) => {
    const path = [...base, i];
    return [
      { step, path, depth },
      ...branchesOf(step).flatMap((branch) => flatten(branch.steps, [...path, branch.key], depth + 1)),
    ];
  });
}

export const allIds = (steps: Step[]) => flatten(steps).map((placed) => placed.step.id);
export const countSteps = (steps: Step[]) => flatten(steps).length;

/** A step with the lists it holds emptied, for showing or testing the step on its own. */
export function withoutChildren(step: Step): Step {
  const copy = { ...step } as unknown as Record<string, unknown>;
  for (const key of BRANCH_KEYS) if (Array.isArray(copy[key])) copy[key] = [];
  return copy as unknown as Step;
}

/**
 * What a step's templates can refer to: the trigger, every step that has finished before it runs
 * (earlier steps in its own list and in each list around it), and the loop it sits in.
 */
export function refsFor(steps: Step[], path: Path): string[] {
  const refs = ["trigger.body"];
  let inLoop = false;
  let list: Step[] | null = steps;
  for (let i = 0; i < path.length && list; i += 2) {
    const index = path[i] as number;
    for (const earlier of list.slice(0, index)) refs.push(`steps.${earlier.id}`);
    const key = path[i + 1] as BranchKey | undefined;
    if (key === undefined) break;
    if (key === "steps") inLoop = true;
    list = list[index] ? childList(list[index], key) : null;
  }
  if (inLoop) refs.push("loop.item", "loop.index");
  return [...refs, "run.id", "workflow.name"];
}

/**
 * Splits a validation issue's path (`["steps", 2, "then", 0, "config", "url"]`) into the step it
 * belongs to and the field inside that step. Null for issues that aren't about a step.
 */
export function issueStep(issuePath: (string | number)[]): { path: Path; field: string } | null {
  if (issuePath[0] !== "steps" || typeof issuePath[1] !== "number") return null;
  const path: Path = [issuePath[1]];
  let i = 2;
  while (BRANCH_KEYS.includes(issuePath[i] as BranchKey) && typeof issuePath[i + 1] === "number") {
    path.push(issuePath[i] as BranchKey, issuePath[i + 1] as number);
    i += 2;
  }
  return { path, field: issuePath.slice(i).join(".") };
}
