import type { Step } from "../../shared/schema";
import { branchesOf, type Path } from "../../shared/tree";

/**
 * Where everything on the canvas goes. The canvas has no positions of its own to save: it is drawn
 * from the workflow's steps every time, top to bottom, with a block's lists side by side under it.
 * All numbers are in canvas units (CSS pixels at 100% zoom); x = 0 is the middle of the trigger.
 */

export const NODE_W = 264;
export const NODE_H = 64;
/** Between two nodes. The "+" that adds a step sits in the middle of it. */
export const GAP = 56;
/** Between a block and the top of its lists: room for the wires to fan out and for each list's label. */
const FORK = 48;
/** Under a block's lists, where the wires come back together. */
const MERGE = 24;
const BRANCH_GAP = 32;
/** Space between a loop's steps and the frame drawn around them. */
const FRAME_PAD = 16;
const CORNER = 12;

export interface NodeBox {
  kind: "trigger" | "step";
  /** Empty for the trigger. */
  path: Path;
  step?: Step;
  /** Top-left corner. */
  x: number;
  y: number;
}

export interface Slot {
  /** Where a step added here goes (see Path in shared/tree.ts). */
  path: Path;
  /** Center. */
  x: number;
  y: number;
}

export interface Wire {
  d: string;
  dashed?: boolean;
}

export interface Label {
  text: string;
  x: number;
  y: number;
}

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  nodes: NodeBox[];
  slots: Slot[];
  wires: Wire[];
  labels: Label[];
  frames: Frame[];
  bounds: { x: number; y: number; w: number; h: number };
}

interface Size {
  w: number;
  h: number;
}

function sizeOfStep(step: Step): Size {
  const branches = branchesOf(step);
  if (branches.length === 0) return { w: NODE_W, h: NODE_H };
  const lists = branches.map((b) => sizeOfList(b.steps));
  const pad = branches.length === 1 ? FRAME_PAD * 2 : 0;
  const w = lists.reduce((sum, s) => sum + s.w, 0) + BRANCH_GAP * (lists.length - 1) + pad;
  return { w: Math.max(NODE_W, w), h: NODE_H + FORK + Math.max(...lists.map((s) => s.h)) + MERGE };
}

function sizeOfList(steps: Step[]): Size {
  const sizes = steps.map(sizeOfStep);
  return {
    w: Math.max(NODE_W, ...sizes.map((s) => s.w)),
    h: GAP + sizes.reduce((sum, s) => sum + s.h + GAP, 0),
  };
}

/** A wire from (x1, y1) down, across at `turn`, and down to (x2, y2), with rounded corners. */
function elbow(x1: number, y1: number, x2: number, y2: number, turn: number): string {
  if (Math.abs(x2 - x1) < 1) return `M${x1} ${y1}V${y2}`;
  const r = Math.min(CORNER, Math.abs(x2 - x1) / 2, turn - y1, y2 - turn);
  const dir = x2 > x1 ? 1 : -1;
  return `M${x1} ${y1}V${turn - r}Q${x1} ${turn} ${x1 + dir * r} ${turn}H${x2 - dir * r}Q${x2} ${turn} ${x2} ${turn + r}V${y2}`;
}

export function layout(steps: Step[]): Layout {
  const out: Layout = { nodes: [], slots: [], wires: [], labels: [], frames: [], bounds: { x: 0, y: 0, w: 0, h: 0 } };

  /** Draws a list centered on `cx` from `top` down and returns where it ends. */
  function placeList(list: Step[], base: Path, cx: number, top: number, last: boolean): number {
    let y = top;
    list.forEach((step, i) => {
      out.wires.push({ d: `M${cx} ${y}V${y + GAP}` });
      out.slots.push({ path: [...base, i], x: cx, y: y + GAP / 2 });
      y += GAP;
      y = placeStep(step, [...base, i], cx, y);
    });
    out.slots.push({ path: [...base, list.length], x: cx, y: y + GAP / 2 });
    if (last) {
      // The end of the workflow: the wire stops at the "+" instead of leading on.
      out.wires.push({ d: `M${cx} ${y}V${y + GAP / 2}`, dashed: true });
      return y + GAP / 2 + 16;
    }
    out.wires.push({ d: `M${cx} ${y}V${y + GAP}` });
    return y + GAP;
  }

  function placeStep(step: Step, path: Path, cx: number, top: number): number {
    out.nodes.push({ kind: "step", path, step, x: cx - NODE_W / 2, y: top });
    const branches = branchesOf(step);
    if (branches.length === 0) return top + NODE_H;

    const sizes = branches.map((b) => sizeOfList(b.steps));
    const tallest = Math.max(...sizes.map((s) => s.h));
    const total = sizes.reduce((sum, s) => sum + s.w, 0) + BRANCH_GAP * (sizes.length - 1);
    const fork = top + NODE_H;
    const listTop = fork + FORK;
    const listBottom = listTop + tallest;
    let left = cx - total / 2;
    branches.forEach((branch, i) => {
      const bx = left + sizes[i].w / 2;
      left += sizes[i].w + BRANCH_GAP;
      out.wires.push({ d: elbow(cx, fork, bx, listTop, fork + 16) });
      out.labels.push({ text: branch.label, x: bx, y: fork + 34 });
      const end = placeList(branch.steps, [...path, branch.key], bx, listTop, false);
      // A shorter list's wire runs on down to where the lists come back together.
      out.wires.push({ d: elbow(bx, end, cx, listBottom + MERGE, listBottom + MERGE / 2) });
      if (branches.length === 1) {
        out.frames.push({ x: bx - sizes[i].w / 2 - FRAME_PAD, y: fork + 20, w: sizes[i].w + FRAME_PAD * 2, h: listBottom - fork - 12 });
      }
    });
    return listBottom + MERGE;
  }

  out.nodes.push({ kind: "trigger", path: [], x: -NODE_W / 2, y: 0 });
  const bottom = placeList(steps, [], 0, NODE_H, true);
  const w = Math.max(NODE_W, sizeOfList(steps).w);
  out.bounds = { x: -w / 2, y: 0, w, h: bottom };
  return out;
}
