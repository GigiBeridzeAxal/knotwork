import { useEffect, useState } from "react";
import { LIMITS } from "../../shared/limits";
import { childLists, type Step, type StepType, walkSteps } from "../../shared/schema";
import { newStep, STEP_TYPES } from "../../shared/examples";
import type { Issue } from "../api";
import { Button, cn, Eyebrow } from "../components/ui";
import { StepEditor } from "./StepEditor";

type Path = (string | number)[];

const startsWith = (path: Path, prefix: Path) => prefix.every((part, i) => path[i] === part);
const BRANCH_LABEL = { then: "Then", else: "Else", steps: "For each item" } as const;

/**
 * A list of steps, and inside each `if` or `loop` step the lists it holds, drawn the same way one
 * level in. Each list keeps track of which of its own steps is open.
 */
export function StepList({
  steps,
  onChange,
  path = ["steps"],
  depth = 1,
  issues,
  refs,
  tailRefs,
  takenIds,
  rev,
}: {
  steps: Step[];
  onChange: (steps: Step[]) => void;
  /** Where this list sits in the workflow, the way validation issues name it. */
  path?: Path;
  depth?: number;
  issues: Issue[];
  /** What steps in this list can refer to before any of the list's own steps. */
  refs: string[];
  /** What every step can refer to, shown last. */
  tailRefs: string[];
  /** Every step id in the workflow, so a new step gets one that is free. */
  takenIds: string[];
  /** Changes when the step editors must throw away their local text (after a save or a load). */
  rev: number;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  // Moving or removing a step shifts the others, so their editors are remounted too.
  const [shuffles, setShuffles] = useState(0);

  // After a save the server refused, open the first step in this list it complained about.
  useEffect(() => {
    const first = issues.find((x) => startsWith(x.path, path) && typeof x.path[path.length] === "number");
    if (first) setOpen(first.path[path.length] as number);
    // Only when a new set of issues arrives: `path` is a fresh array on every render.
  }, [issues]);

  const top = depth === 1;
  const types = STEP_TYPES.filter((t) => depth < LIMITS.stepDepth || (t.type !== "if" && t.type !== "loop"));

  function add(type: StepType) {
    onChange([...steps, newStep(type, takenIds)]);
    setOpen(steps.length);
    setPicking(false);
  }

  function move(i: number, dir: -1 | 1) {
    const next = [...steps];
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    onChange(next);
    setShuffles((n) => n + 1);
    if (open === i) setOpen(i + dir);
    else if (open === i + dir) setOpen(i);
  }

  /** Ids of the steps before position `i` in this list, counting the ones inside their blocks. */
  const before = (i: number) => {
    const ids: string[] = [];
    walkSteps(steps.slice(0, i), (s) => ids.push(`steps.${s.id}`));
    return ids;
  };

  const picker = (
    <div className={cn("grid grid-cols-2 gap-2", top ? "sm:grid-cols-4" : "sm:grid-cols-3")}>
      {types.map((t) => (
        <button
          key={t.type}
          type="button"
          onClick={() => add(t.type)}
          className="flex min-h-11 flex-col items-start gap-1 rounded-[10px] border border-line bg-ink p-3 text-left hover:border-edge"
        >
          <span className="text-sm font-medium">{t.label}</span>
          <span className="text-xs text-muted">{t.blurb}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col">
      {steps.map((step, i) => {
        const at = [...path, i];
        const mine = issues.filter((x) => startsWith(x.path, at));
        // A block's own problems, not the ones inside its lists (those show on the steps inside).
        const own = mine.filter((x) => !childLists(step).some(([name]) => x.path[at.length] === name));
        const inner = [...refs, ...before(i)];
        return (
          <div key={`${rev}-${shuffles}-${i}-${step.type}`} className="flex flex-col">
            {(top || i > 0) && <Wire />}
            <StepEditor
              step={step}
              index={i}
              uid={`s${at.slice(1).join("-")}`}
              total={steps.length}
              refs={[...inner, ...tailRefs]}
              errors={own.map((x) => `${x.path.slice(at.length).join(".") || "step"}: ${x.message}`)}
              open={open === i}
              onToggle={() => setOpen(open === i ? null : i)}
              onChange={(s) => onChange(steps.map((x, j) => (j === i ? s : x)))}
              onMove={(dir) => move(i, dir)}
              onRemove={() => {
                onChange(steps.filter((_, j) => j !== i));
                setShuffles((n) => n + 1);
                setOpen(null);
              }}
            />
            {childLists(step).map(([name, list]) => (
              <div key={name} className="ml-4 flex flex-col gap-3 border-l-2 border-line pt-4 pl-4 sm:ml-6 sm:pl-6" role="group" aria-label={`${step.name}: ${BRANCH_LABEL[name]}`}>
                <Eyebrow>{BRANCH_LABEL[name]}</Eyebrow>
                <StepList
                  steps={list}
                  onChange={(next) => onChange(steps.map((x, j) => (j === i ? ({ ...x, [name]: next } as Step) : x)))}
                  path={[...at, name]}
                  depth={depth + 1}
                  issues={issues}
                  refs={step.type === "loop" ? [...inner, "loop.item", "loop.index"] : inner}
                  tailRefs={tailRefs}
                  takenIds={takenIds}
                  rev={rev}
                />
              </div>
            ))}
          </div>
        );
      })}

      {top ? (
        <>
          <Wire dashed />
          <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-line bg-graphite p-4">
            <Eyebrow>Add a step</Eyebrow>
            {picker}
          </div>
        </>
      ) : (
        <div className={cn("flex flex-col gap-3", steps.length > 0 && "pt-3")}>
          {steps.length === 0 && !picking && <p className="text-[13px] text-muted">No steps here yet.</p>}
          {picking && picker}
          <Button variant="ghost" className="self-start" aria-expanded={picking} onClick={() => setPicking((v) => !v)}>
            {picking ? "Cancel" : "+ Add step"}
          </Button>
        </div>
      )}
    </div>
  );
}

function Wire({ dashed = false }: { dashed?: boolean }) {
  return (
    <div className="flex h-8 justify-center" aria-hidden="true">
      <div className={cn("w-0.5", dashed ? "border-l-2 border-dashed border-edge" : "bg-wire")} />
    </div>
  );
}
