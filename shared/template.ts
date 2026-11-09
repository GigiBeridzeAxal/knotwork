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

export function renderString(template: string, scope: unknown): unknown {
  const whole = WHOLE.exec(template);
  if (whole) return lookup(scope, whole[1].trim());
  return template.replace(TEMPLATE, (_, path: string) => toText(lookup(scope, path.trim())));
}

/** Render every string inside a JSON value. */
export function render(value: unknown, scope: unknown): unknown {
  if (typeof value === "string") return renderString(value, scope);
  if (Array.isArray(value)) return value.map((item) => render(item, scope));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, scope)]));
  }
  return value;
}

/** Render to text, for places that need a string (URLs, headers, log lines). */
export function renderText(template: string, scope: unknown): string {
  return toText(renderString(template, scope));
}
