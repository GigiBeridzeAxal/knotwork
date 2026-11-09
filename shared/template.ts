/**
 * Templates: `{{ path.to.value }}` inside any string. A string that is nothing but one template keeps
 * the value's type (so `"{{ trigger.body.items }}"` stays an array); anywhere else the value is
 * turned into text. Paths are dotted lookups only, with array indexes as numbers
 * (`steps.fetch.body.items.0.name`). No expressions are evaluated, so a template can't run code.
 */

// No lazy quantifiers next to \s*: the old /\{\{\s*([^{}]*?)\s*\}\}/ took super-linear time on "{{" + spaces.
const TEMPLATE = /\{\{([^{}]*)\}\}/g;
const WHOLE = /^\{\{([^{}]*)\}\}$/;
const PATH = /^[A-Za-z_$][\w$-]*(\.[\w$-]+)*$/;

export function lookup(scope: unknown, path: string): unknown {
  if (!PATH.test(path)) return undefined;
  let value: unknown = scope;
  for (const key of path.split(".")) {
    if (value === null || value === undefined) return undefined;
    if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
    if (typeof value !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function toText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** The most text one step's templates may produce, counted across everything the step renders. */
export const MAX_RENDER_CHARS = 64_000;

export class TemplateTooLarge extends Error {
  constructor() {
    super(`This step's templates add up to more than ${MAX_RENDER_CHARS / 1000} KB of data`);
  }
}

/**
 * How much more a step may render. A template can name the same large value many times
 * (`{{ trigger }}` × 1,000), so every use is charged at the value's full size; each path's text is
 * worked out once and reused, so even that costs one JSON.stringify per path.
 */
export interface Budget {
  left: number;
  texts: Map<string, string>;
}

export const newBudget = (max = MAX_RENDER_CHARS): Budget => ({ left: max, texts: new Map() });

function textOf(scope: unknown, path: string, budget: Budget): string {
  let text = budget.texts.get(path);
  if (text === undefined) {
    text = toText(lookup(scope, path));
    budget.texts.set(path, text);
  }
  budget.left -= text.length;
  if (budget.left < 0) throw new TemplateTooLarge();
  return text;
}

export function renderString(template: string, scope: unknown, budget = newBudget()): unknown {
  const whole = WHOLE.exec(template);
  if (whole) {
    const path = whole[1].trim();
    textOf(scope, path, budget);
    return lookup(scope, path);
  }
  budget.left -= template.length;
  if (budget.left < 0) throw new TemplateTooLarge();
  return template.replace(TEMPLATE, (_, path: string) => textOf(scope, path.trim(), budget));
}

/** Render every string inside a JSON value. */
export function render(value: unknown, scope: unknown, budget = newBudget()): unknown {
  if (typeof value === "string") return renderString(value, scope, budget);
  if (Array.isArray(value)) return value.map((item) => render(item, scope, budget));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, scope, budget)]));
  }
  return value;
}

/** Render to text, for places that need a string (URLs, headers, log lines). */
export function renderText(template: string, scope: unknown, budget = newBudget()): string {
  return toText(renderString(template, scope, budget));
}
