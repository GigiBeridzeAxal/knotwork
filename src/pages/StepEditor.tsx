import { useState } from "react";
import { filterOps, type FilterOp, type Step } from "../../shared/schema";
import { Button, cn, Eyebrow, Field, inputClass, textareaClass } from "../components/ui";
import { STEP_TYPES } from "../../shared/examples";
import { LIMITS } from "../../shared/limits";

const OP_LABELS: Record<FilterOp, string> = {
  equals: "equals",
  not_equals: "does not equal",
  contains: "contains",
  gt: "is greater than",
  lt: "is less than",
  exists: "has a value",
  not_exists: "is empty",
};

// Step types share one quiet color: amber and red are kept for problems, lime for live states.
const TYPE_COLOR: Record<Step["type"], string> = {
  http: "text-muted",
  transform: "text-muted",
  filter: "text-muted",
  delay: "text-muted",
  log: "text-muted",
  if: "text-muted",
  loop: "text-muted",
};

/** JSON when it parses, the raw text when it doesn't (a plain string is a valid body or output). */
function parseLoose(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}

function show(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function JsonArea({
  id,
  value,
  onChange,
  rows = 6,
  placeholder,
}: {
  id: string;
  value: unknown;
  onChange: (v: unknown) => void;
  rows?: number;
  placeholder?: string;
}) {
  const [text, setText] = useState(() => show(value));
  const isText = text.trim() !== "" && typeof parseLoose(text) === "string";
  return (
    <>
      <textarea
        id={id}
        rows={rows}
        spellCheck={false}
        className={textareaClass}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseLoose(e.target.value));
        }}
      />
      {isText && <p className="text-[13px] text-retry">This isn't JSON, so it will be used as plain text.</p>}
    </>
  );
}

export function StepEditor({
  step,
  index,
  uid = `s${index}`,
  total,
  refs,
  errors,
  open,
  onToggle,
  onChange,
  onMove,
  onRemove,
  embedded = false,
}: {
  step: Step;
  index: number;
  /** A prefix for the form fields' ids that is unique on the page (steps in different lists share an index). */
  uid?: string;
  total: number;
  refs: string[];
  errors: string[];
  open: boolean;
  onToggle: () => void;
  onChange: (step: Step) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  /** Just the fields, always open, with no card around them: for the canvas, which has its own panel. */
  embedded?: boolean;
}) {
  const typeInfo = STEP_TYPES.find((t) => t.type === step.type)!;
  const set = (patch: Partial<Step>) => onChange({ ...step, ...patch } as Step);
  const setConfig = (patch: Record<string, unknown>) => onChange({ ...step, config: { ...step.config, ...patch } } as Step);

  return (
    <div
      className={cn(
        !embedded && "rounded-2xl border bg-graphite transition-colors",
        !embedded && (errors.length ? "border-fail/60" : open ? "border-spark" : "border-line"),
      )}
    >
      <div className={cn("flex items-center gap-3 p-4", embedded && "hidden")}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
        >
          <span className={cn("font-mono text-[11px] tracking-[0.12em] uppercase", TYPE_COLOR[step.type])}>
            Step {index + 1} · {typeInfo.label}
          </span>
          <span className="w-full truncate font-semibold">{step.name}</span>
          <span className="font-mono text-xs text-muted">steps.{step.id}</span>
        </button>
        <div className="flex items-center">
          <Button variant="ghost" className="w-11 px-0" aria-label="Move step up" disabled={index === 0} onClick={() => onMove(-1)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 10l4-4 4 4" /></svg>
          </Button>
          <Button variant="ghost" className="w-11 px-0" aria-label="Move step down" disabled={index === total - 1} onClick={() => onMove(1)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
          </Button>
        </div>
      </div>

      {errors.length > 0 && (
        <ul className={cn("mb-3 list-disc pl-5 text-[13px] text-fail", !embedded && "mx-4")}>
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      {(open || embedded) && (
        <div className={cn("flex flex-col gap-5", !embedded && "border-t border-line p-4")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor={`${uid}-name`}>
              <input id={`${uid}-name`} className={inputClass} value={step.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Id (how later steps refer to it)" htmlFor={`${uid}-id`}>
              <input
                id={`${uid}-id`}
                className={cn(inputClass, "font-mono")}
                value={step.id}
                onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
              />
            </Field>
          </div>

          {step.type === "http" && (
            <>
              <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
                <Field label="Method" htmlFor={`${uid}-method`}>
                  <select
                    id={`${uid}-method`}
                    className={inputClass}
                    value={step.config.method}
                    onChange={(e) => setConfig({ method: e.target.value })}
                  >
                    {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </Field>
                <Field label="URL" htmlFor={`${uid}-url`}>
                  <input
                    id={`${uid}-url`}
                    className={cn(inputClass, "font-mono")}
                    value={step.config.url}
                    onChange={(e) => setConfig({ url: e.target.value })}
                  />
                </Field>
              </div>
              <Headers
                uid={uid}
                headers={step.config.headers}
                onChange={(headers) => setConfig({ headers })}
              />
              {step.config.method !== "GET" && (
                <Field label="Body" htmlFor={`${uid}-body`} hint="JSON is sent as application/json. Templates work inside it.">
                  <JsonArea id={`${uid}-body`} value={step.config.body} onChange={(body) => setConfig({ body })} placeholder='{ "text": "{{ trigger.body.message }}" }' />
                </Field>
              )}
              <label className="flex items-center gap-3 text-sm text-soft">
                <input
                  type="checkbox"
                  className="size-4 accent-spark"
                  checked={step.config.failOnError}
                  onChange={(e) => setConfig({ failOnError: e.target.checked })}
                />
                Treat a 4xx or 5xx answer as a failure
              </label>
            </>
          )}

          {step.type === "transform" && (
            <Field label="Output" htmlFor={`${uid}-output`} hint="Any JSON. Every string in it is a template, and the result becomes this step's output.">
              <JsonArea id={`${uid}-output`} rows={8} value={step.config.output} onChange={(output) => setConfig({ output })} />
            </Field>
          )}

          {step.type === "loop" && (
            <Field
              label="List to go through"
              htmlFor={`${uid}-items`}
              hint={`A template that gives a list, up to ${LIMITS.loopItems} items. The steps inside run once per item, with {{ loop.item }}, {{ loop.index }} (from 0) and {{ loop.count }}.`}
            >
              <input id={`${uid}-items`} className={cn(inputClass, "font-mono")} value={step.config.items} onChange={(e) => setConfig({ items: e.target.value })} />
            </Field>
          )}

          {(step.type === "filter" || step.type === "if") && (
            <div className="grid gap-4 sm:grid-cols-[1fr_180px_1fr]">
              <Field label="Value" htmlFor={`${uid}-left`}>
                <input id={`${uid}-left`} className={cn(inputClass, "font-mono")} value={step.config.left} onChange={(e) => setConfig({ left: e.target.value })} />
              </Field>
              <Field label="Condition" htmlFor={`${uid}-op`}>
                <select id={`${uid}-op`} className={inputClass} value={step.config.op} onChange={(e) => setConfig({ op: e.target.value })}>
                  {filterOps.map((op) => (
                    <option key={op} value={op}>
                      {OP_LABELS[op]}
                    </option>
                  ))}
                </select>
              </Field>
              {!step.config.op.endsWith("exists") && (
                <Field label="Compare with" htmlFor={`${uid}-right`}>
                  <input id={`${uid}-right`} className={cn(inputClass, "font-mono")} value={step.config.right} onChange={(e) => setConfig({ right: e.target.value })} />
                </Field>
              )}
            </div>
          )}

          {step.type === "delay" && (
            <Field label="Wait (seconds)" htmlFor={`${uid}-seconds`} hint="The run is parked and picked up again by the next minute tick.">
              <input
                id={`${uid}-seconds`}
                type="number"
                min={1}
                className={cn(inputClass, "max-w-48")}
                value={step.config.seconds}
                onChange={(e) => setConfig({ seconds: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
              />
            </Field>
          )}

          {step.type === "log" && (
            <Field label="Message" htmlFor={`${uid}-message`}>
              <input id={`${uid}-message`} className={cn(inputClass, "font-mono")} value={step.config.message} onChange={(e) => setConfig({ message: e.target.value })} />
            </Field>
          )}

          {step.type === "http" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Retries if it fails" htmlFor={`${uid}-retries`}>
                <select
                  id={`${uid}-retries`}
                  className={inputClass}
                  value={step.retry.max}
                  onChange={(e) => set({ retry: { ...step.retry, max: Number(e.target.value) } })}
                >
                  {[0, 1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? "Don't retry" : `${n} ${n === 1 ? "retry" : "retries"}`}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="First wait (seconds)"
                htmlFor={`${uid}-backoff`}
                hint={`Then ${step.retry.backoffSeconds * 4}s, ${step.retry.backoffSeconds * 16}s…`}
              >
                <input
                  id={`${uid}-backoff`}
                  type="number"
                  min={1}
                  className={inputClass}
                  value={step.retry.backoffSeconds}
                  onChange={(e) =>
                    set({ retry: { ...step.retry, backoffSeconds: Math.max(1, Math.round(Number(e.target.value) || 1)) } })
                  }
                />
              </Field>
            </div>
          )}

          <div className="flex flex-col gap-2 rounded-[10px] bg-ink p-3">
            <Eyebrow>You can use</Eyebrow>
            <div className="flex flex-wrap gap-2 font-mono text-xs text-soft">
              {refs.map((r) => (
                <code key={r} className="rounded bg-graphite px-2 py-1">{`{{ ${r} }}`}</code>
              ))}
            </div>
          </div>

          <div className={cn("flex justify-end", embedded && "hidden")}>
            <Button variant="danger" onClick={onRemove}>
              Remove step
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Headers({
  uid,
  headers,
  onChange,
}: {
  uid: string;
  headers: Record<string, string>;
  onChange: (h: Record<string, string>) => void;
}) {
  const [rows, setRows] = useState(() => Object.entries(headers));
  const update = (next: [string, string][]) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter(([k]) => k.trim())));
  };
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-[13px] text-soft">Headers</legend>
      {rows.map(([k, v], i) => (
        <div key={i} className="flex gap-2">
          <input
            aria-label={`Header ${i + 1} name`}
            className={cn(inputClass, "w-2/5 font-mono")}
            placeholder="authorization"
            value={k}
            onChange={(e) => update(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
          />
          <input
            aria-label={`Header ${i + 1} value`}
            className={cn(inputClass, "font-mono")}
            placeholder="Bearer …"
            value={v}
            onChange={(e) => update(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
          />
          <Button variant="ghost" className="w-11 shrink-0 px-0" aria-label={`Remove header ${i + 1}`} onClick={() => update(rows.filter((_, j) => j !== i))}>
            <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" /></svg>
          </Button>
        </div>
      ))}
      <Button variant="ghost" className="self-start" id={`${uid}-add-header`} onClick={() => update([...rows, ["", ""]])}>
        + Add header
      </Button>
    </fieldset>
  );
}
