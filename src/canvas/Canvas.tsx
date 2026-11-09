import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { STEP_TYPES } from "../../shared/examples";
import type { Step, StepType, Trigger } from "../../shared/schema";
import { LIMITS } from "../../shared/limits";
import { levelOf, moveStep, type Path, pathKey, samePath } from "../../shared/tree";
import { PlusIcon } from "../components/icons";
import { cn } from "../components/ui";
import { describeStep, describeTrigger, Glyph, typeLabel } from "./describe";
import { layout, NODE_H, NODE_W, type Slot } from "./layout";

/** What is selected on the canvas: the trigger, a step (by its path), or nothing. */
export type Selection = "trigger" | Path | null;

interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.5;
/** How far a pointer may move before a press counts as a drag instead of a click. */
const DRAG_START = 6;
/** How close (in canvas units) a dragged step must be to a gap to drop into it. */
const DROP_RADIUS = 96;
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));

interface Drag {
  from: Path;
  /** The pointer, in canvas units. */
  x: number;
  y: number;
  /** Where in the node it was picked up, so the node doesn't jump under the pointer. */
  dx: number;
  dy: number;
  target: Slot | null;
}

export function Canvas({
  trigger,
  steps,
  enabled,
  selected,
  onSelect,
  errors,
  readOnly = false,
  full = false,
  onInsert,
  onMove,
  fitKey,
  topInset = 0,
  className,
}: {
  trigger: Trigger;
  steps: Step[];
  enabled: boolean;
  selected: Selection;
  onSelect: (selection: Selection) => void;
  /** Path keys of steps the last save found problems in. */
  errors?: Set<string>;
  readOnly?: boolean;
  /** The workflow has as many steps as it may: the gaps stop offering to add one. */
  full?: boolean;
  onInsert?: (slot: Path, type: StepType) => void;
  onMove?: (from: Path, slot: Path) => void;
  /** The view fits the workflow again whenever this changes (another workflow, another version). */
  fitKey?: unknown;
  /** Extra space to leave above the trigger when fitting (a banner over the top of the board). */
  topInset?: number;
  className?: string;
}) {
  const board = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [picker, setPicker] = useState<Slot | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const plan = useMemo(() => layout(steps), [steps]);
  // No "+" where a step would sit deeper than a workflow allows.
  const stepSlots = readOnly ? [] : plan.slots.filter((slot) => levelOf(slot.path) <= LIMITS.stepDepth);
  const lastSlot = stepSlots.find((s) => s.path.length === 1 && s.path[0] === steps.length);

  const fit = useCallback(() => {
    const el = board.current;
    if (!el) return;
    const w = el.clientWidth;
    // Fit the width only: a long workflow keeps a readable size and continues below the fold.
    const k = clamp((w - 48) / plan.bounds.w, 0.6, 1);
    // Centered across; from the top down, so a long workflow starts at its trigger.
    // Room at the top for the "Starts when" label, and for whatever the page lays over the board there.
    setView({ k, x: w / 2 - (plan.bounds.x + plan.bounds.w / 2) * k, y: 48 + topInset + (w < 560 ? (topInset ? 64 : 24) : 0) });
  }, [plan, topInset]);

  // Fit when the canvas first has a size, and when it is asked to show something else.
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const ready = size.w > 0;
  useLayoutEffect(() => {
    if (ready) fitRef.current();
  }, [ready, fitKey]);

  useEffect(() => {
    const el = board.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const zoomAt = useCallback((px: number, py: number, factor: number) => {
    setView((v) => {
      const k = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM);
      return { k, x: px - (px - v.x) * (k / v.k), y: py - (py - v.y) * (k / v.k) };
    });
  }, []);

  // The wheel pans (as a trackpad expects) and zooms with Ctrl or a pinch. React's wheel listener is
  // passive, so this one is attached by hand to stop the page from scrolling under the canvas.
  useEffect(() => {
    const el = board.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest("[data-scrolls]")) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.01));
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // ---------- Pointers: pan, pinch, and dragging a step to another gap ----------

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const press = useRef<{ id: number; x: number; y: number; node: Path | null; moved: boolean; mouse: boolean } | null>(null);
  const pinch = useRef<{ distance: number } | null>(null);
  /** Set when a press turned into a pan or drag, so the click that follows it is ignored. */
  const swallowClick = useRef(false);

  const toCanvas = (clientX: number, clientY: number) => {
    const rect = board.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k };
  };

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const target = e.target as Element;
    if (target.closest("[data-ui]")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y) };
      press.current = null;
      setDrag(null);
      return;
    }
    const nodeKey = target.closest<HTMLElement>("[data-step]")?.dataset.step;
    const node = nodeKey === undefined ? null : (plan.nodes.find((n) => n.kind === "step" && pathKey(n.path) === nodeKey)?.path ?? null);
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, node, moved: false, mouse: e.pointerType === "mouse" };
    swallowClick.current = false;
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const known = pointers.current.get(e.pointerId);
    if (!known) return;
    const dx = e.clientX - known.x;
    const dy = e.clientY - known.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const rect = board.current!.getBoundingClientRect();
      zoomAt((a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top, distance / pinch.current.distance);
      pinch.current.distance = distance;
      swallowClick.current = true;
      return;
    }

    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (!p.moved) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_START) return;
      p.moved = true;
      swallowClick.current = true;
      setPicker(null);
      board.current!.setPointerCapture(e.pointerId);
      // A mouse drags a step to move it; a finger on a step pans, since on a phone most of the
      // canvas is steps. (On touch, steps are moved with the buttons in the step's panel.)
      if (p.node && p.mouse && !readOnly && onMove) {
        const at = toCanvas(p.x, p.y);
        const box = plan.nodes.find((n) => n.kind === "step" && samePath(n.path, p.node!))!;
        setDrag({ from: p.node, x: at.x, y: at.y, dx: at.x - box.x, dy: at.y - box.y, target: null });
      }
    }
    if (p.node && p.mouse && !readOnly && onMove) {
      const at = toCanvas(e.clientX, e.clientY);
      setDrag((d) => {
        if (!d) return d;
        let target: Slot | null = null;
        let best = DROP_RADIUS;
        for (const slot of plan.slots) {
          const distance = Math.hypot(slot.x - at.x, slot.y - (at.y - d.dy + NODE_H / 2));
          if (distance < best && moveStep(steps, d.from, slot.path)) {
            best = distance;
            target = slot;
          }
        }
        return { ...d, x: at.x, y: at.y, target };
      });
    } else {
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    }
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const p = press.current;
    if (p?.id !== e.pointerId) return;
    press.current = null;
    if (drag) {
      if (drag.target && e.type === "pointerup") onMove?.(drag.from, drag.target.path);
      setDrag(null);
    }
  }

  const toolClass =
    "grid size-10 place-items-center text-soft transition-colors hover:bg-raised hover:text-text disabled:opacity-40 pointer-coarse:size-11";
  const triggerInfo = describeTrigger(trigger);
  const dragged = drag ? plan.nodes.find((n) => n.kind === "step" && samePath(n.path, drag.from)) : null;
  // Tab order follows the flow: top to bottom, then left to right.
  const items = [
    ...plan.nodes.map((node) => ({ node, slot: null as Slot | null, x: node.x, y: node.y + NODE_H / 2 })),
    ...stepSlots.map((slot) => ({ node: null, slot, x: slot.x, y: slot.y })),
  ].sort((a, b) => a.y - b.y || a.x - b.x);

  return (
    <div
      ref={board}
      className={cn("relative touch-none overflow-hidden select-none", drag ? "cursor-grabbing" : "cursor-grab", className)}
      style={{
        backgroundImage: "radial-gradient(var(--color-raised) 1px, transparent 1px)",
        backgroundSize: `${24 * view.k}px ${24 * view.k}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClickCapture={(e) => {
        if (swallowClick.current) {
          swallowClick.current = false;
          e.stopPropagation();
          e.preventDefault();
        }
      }}
      onClick={(e) => {
        // A click on the empty board lets go of whatever is selected.
        if (e.target === e.currentTarget || (e.target as Element).closest("[data-world]") === e.target) {
          setPicker(null);
          onSelect(null);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          if (picker) setPicker(null);
          else onSelect(null);
        }
      }}
    >
      <div
        data-world
        className="absolute top-0 left-0 size-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, visibility: ready ? "visible" : "hidden" }}
      >
        <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1" aria-hidden="true">
          {plan.wires.map((wire, i) => (
            <path key={i} d={wire.d} fill="none" stroke="var(--color-line-hover)" strokeWidth="1.5" strokeDasharray={wire.dashed ? "3 5" : undefined} />
          ))}
        </svg>

        {plan.frames.map((frame, i) => (
          <div
            key={i}
            className="pointer-events-none absolute rounded-2xl border border-dashed border-edge"
            style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
          />
        ))}

        <span
          className="pointer-events-none absolute font-mono text-[11px] tracking-[0.12em] whitespace-nowrap text-muted uppercase"
          style={{ left: -NODE_W / 2, top: -24 }}
        >
          Starts when
        </span>

        {items.map(({ node, slot }) => {
          if (slot) {
            const isLast = slot === lastSlot;
            const isTarget = drag?.target === slot;
            if (full && !drag) return null;
            return (
              <button
                key={`slot-${pathKey(slot.path)}`}
                type="button"
                data-slot={pathKey(slot.path)}
                aria-label={isLast ? undefined : "Add a step here"}
                aria-haspopup="menu"
                aria-expanded={picker === slot}
                onClick={() => setPicker(picker === slot ? null : slot)}
                className={cn(
                  "absolute flex h-6 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center gap-1.5 rounded-full border bg-deep text-muted transition-colors",
                  "before:absolute before:-inset-2.5 before:content-[''] hover:border-soft hover:text-text",
                  isLast ? "px-3 text-xs font-medium whitespace-nowrap text-soft" : "w-6",
                  isTarget ? "scale-125 border-spark text-spark" : picker === slot ? "border-soft text-text" : "border-edge",
                  drag && !isTarget && "opacity-60",
                )}
                style={{ left: slot.x, top: slot.y }}
              >
                <PlusIcon className="size-3.5" />
                {isLast && (steps.length === 0 ? "Add the first step" : "Add a step")}
              </button>
            );
          }
          if (!node) return null;
          if (node.kind === "trigger") {
            const active = selected === "trigger";
            return (
              <button
                key="trigger"
                type="button"
                data-trigger
                aria-pressed={active}
                onClick={() => onSelect("trigger")}
                className={cn(nodeClass, active ? "border-spark" : "border-edge hover:border-line-hover")}
                style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
              >
                <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg bg-raised", enabled ? "text-spark" : "text-muted")}>
                  <Glyph type={trigger.type} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-text">{triggerInfo.label}</span>
                  <span className="truncate font-mono text-[11px] text-muted">{enabled ? triggerInfo.detail : "Turned off"}</span>
                </span>
              </button>
            );
          }
          const step = node.step!;
          const key = pathKey(node.path);
          const active = selected !== null && selected !== "trigger" && samePath(selected, node.path);
          const broken = errors?.has(key);
          return (
            <button
              key={`step-${key}-${step.id}`}
              type="button"
              data-step={key}
              aria-pressed={active}
              aria-label={`${step.name}, ${typeLabel(step.type)}${broken ? ", needs fixing" : ""}`}
              onClick={() => onSelect(node.path)}
              className={cn(
                nodeClass,
                active ? "border-spark" : broken ? "border-fail/70" : "border-line hover:border-line-hover",
                dragged === node && "opacity-30",
              )}
              style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
            >
              <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg bg-raised", broken ? "text-fail" : "text-soft")}>
                <Glyph type={step.type} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-text">{step.name}</span>
                <span className="truncate font-mono text-[11px] text-muted">{describeStep(step) || typeLabel(step.type)}</span>
              </span>
            </button>
          );
        })}

        {plan.labels.map((label, i) => (
          <span
            key={i}
            className="pointer-events-none absolute flex h-5 -translate-x-1/2 -translate-y-1/2 items-center rounded-full border border-line bg-deep px-2 font-mono text-[11px] whitespace-nowrap text-muted"
            style={{ left: label.x, top: label.y }}
          >
            {label.text}
          </span>
        ))}

        {drag && dragged?.step && (
          <div
            className={cn(nodeClass, "pointer-events-none border-soft shadow-[0_16px_32px_-8px_rgb(0_0_0/0.7)]")}
            style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: NODE_W, height: NODE_H }}
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-raised text-soft">
              <Glyph type={dragged.step.type} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium text-text">{dragged.step.name}</span>
              <span className="truncate font-mono text-[11px] text-muted">{drag.target ? "Drop to move here" : "Drag to a +"}</span>
            </span>
          </div>
        )}
      </div>

      {picker && !readOnly && (
        <StepPicker
          narrow={size.w < 560}
          left={clamp(picker.x * view.k + view.x - 140, 8, Math.max(8, size.w - 288))}
          top={picker.y * view.k + view.y + 20}
          boardHeight={size.h}
          blocks={levelOf(picker.path) < LIMITS.stepDepth}
          onClose={() => setPicker(null)}
          onPick={(type) => {
            const slot = picker.path;
            setPicker(null);
            onInsert?.(slot, type);
          }}
        />
      )}

      <div data-ui className="absolute bottom-3 left-3 flex cursor-default overflow-hidden rounded-xl border border-line bg-graphite">
        <button type="button" className={toolClass} aria-label="Zoom out" disabled={view.k <= MIN_ZOOM} onClick={() => zoomAt(size.w / 2, size.h / 2, 1 / 1.25)}>
          <svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 8h8" /></svg>
        </button>
        <span className="grid w-12 place-items-center font-mono text-[11px] text-muted tabular-nums" aria-live="off">
          {Math.round(view.k * 100)}%
        </span>
        <button type="button" className={toolClass} aria-label="Zoom in" disabled={view.k >= MAX_ZOOM} onClick={() => zoomAt(size.w / 2, size.h / 2, 1.25)}>
          <svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 8h8M8 4v8" /></svg>
        </button>
        <button type="button" className={cn(toolClass, "w-auto border-l border-line px-3 text-xs font-medium pointer-coarse:w-auto")} onClick={fit}>
          Fit
        </button>
      </div>
    </div>
  );
}

const nodeClass =
  "absolute flex cursor-pointer items-center gap-3 rounded-xl border bg-graphite px-3 text-left transition-colors focus-visible:outline-offset-4";

/** The menu a "+" opens: every kind of step, with a line on what it does. */
function StepPicker({
  narrow,
  left,
  top,
  boardHeight,
  blocks,
  onPick,
  onClose,
}: {
  narrow: boolean;
  left: number;
  top: number;
  boardHeight: number;
  /** False at the deepest level, where a block would have nowhere to keep its steps. */
  blocks: boolean;
  onPick: (type: StepType) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("button")?.focus({ preventScroll: true });
    const away = (e: PointerEvent) => {
      const target = e.target as Element;
      if (!ref.current?.contains(target) && !target.closest("[data-slot]")) onClose();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [onClose]);
  // On a narrow board the menu is a sheet along the bottom; otherwise it opens under the "+", or
  // above it when there is no room below.
  const height = Math.min(STEP_TYPES.length * 52 + 44, boardHeight - 16);
  const flip = !narrow && top + height > boardHeight - 8;
  return (
    <div
      ref={ref}
      data-ui
      data-scrolls
      role="menu"
      aria-label="Add a step"
      className={cn(
        "absolute z-10 cursor-default overflow-y-auto rounded-2xl border border-line bg-graphite p-1.5 shadow-[0_24px_48px_-12px_rgb(0_0_0/0.7)]",
        narrow ? "inset-x-2 bottom-2" : "w-70",
      )}
      style={narrow ? { maxHeight: boardHeight - 16 } : { left, top: flip ? Math.max(8, top - height - 40) : top, maxHeight: height }}
    >
      <p className="px-2.5 pt-1.5 pb-2 font-mono text-[11px] tracking-[0.12em] text-muted uppercase">Add a step</p>
      {STEP_TYPES.filter((t) => blocks || (t.type !== "if" && t.type !== "loop")).map((t) => (
        <button
          key={t.type}
          type="button"
          role="menuitem"
          onClick={() => onPick(t.type)}
          className="flex min-h-13 w-full items-center gap-3 rounded-lg px-2.5 text-left transition-colors hover:bg-raised focus-visible:bg-raised"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-raised text-soft">
            <Glyph type={t.type} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-[13px] font-medium text-text">{t.label}</span>
            <span className="truncate text-xs text-muted">{t.blurb}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
