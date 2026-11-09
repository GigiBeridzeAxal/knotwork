import { describe, expect, it } from "vitest";
import { workflowInput } from "../shared/schema";
import { TEMPLATE_CATEGORIES, TEMPLATES, findTemplate } from "../shared/templates";
import { DEMO_HOSTS } from "../worker/steps";

/** Every string anywhere inside a JSON value. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("template library", () => {
  it("has unique, URL-safe ids", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(findTemplate("watch-github-repo")?.title).toBe("Watch a GitHub repo");
    expect(findTemplate("nope")).toBeUndefined();
  });

  it("has valid workflows with nothing left to defaults", () => {
    for (const t of TEMPLATES) {
      const parsed = workflowInput.safeParse(t.workflow);
      expect(parsed.success, `${t.id}: ${parsed.error?.message}`).toBe(true);
      expect(parsed.data, t.id).toEqual(t.workflow);
    }
  });

  it("only calls hosts the demo account may call", () => {
    for (const t of TEMPLATES) {
      for (const step of t.workflow.steps) {
        if (step.type !== "http") continue;
        expect(DEMO_HOSTS, `${t.id}/${step.id}`).toContain(new URL(step.config.url).hostname);
      }
    }
  });

  it("only refers to steps that ran earlier", () => {
    for (const t of TEMPLATES) {
      const earlier = new Set<string>();
      for (const step of t.workflow.steps) {
        for (const text of strings(step)) {
          for (const m of text.matchAll(/\{\{\s*steps\.([^.\s}]+)/g)) {
            expect(earlier.has(m[1]), `${t.id}/${step.id} refers to "${m[1]}"`).toBe(true);
          }
        }
        earlier.add(step.id);
      }
    }
  });

  it("has at least two templates per category", () => {
    for (const category of TEMPLATE_CATEGORIES) {
      expect(TEMPLATES.filter((t) => t.category === category).length, category).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps blurbs under 90 characters", () => {
    for (const t of TEMPLATES) expect(t.blurb.length, t.id).toBeLessThan(90);
  });

  it("has sample input exactly when the trigger is not a schedule", () => {
    for (const t of TEMPLATES) {
      expect(t.sampleInput === null, t.id).toBe(t.workflow.trigger.type === "schedule");
    }
  });
});
