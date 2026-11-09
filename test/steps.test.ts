import { describe, expect, it } from "vitest";
import { type LeafStep, workflowInput } from "../shared/schema";
import { compare, executeStep, type Scope } from "../worker/steps";

const scope: Scope = {
  trigger: { body: { amount: 120, status: "paid", tags: ["a", "b"] } },
  steps: {},
  run: { id: "run_1", startedAt: "" },
  workflow: { id: "wf_1", name: "Test" },
  secrets: {},
};

describe("filter", () => {
  it("compares values", () => {
    expect(compare(120, "gt", "100")).toBe(true);
    expect(compare("120", "lt", "100")).toBe(false);
    expect(compare("paid", "equals", "paid")).toBe(true);
    expect(compare(["a", "b"], "contains", "b")).toBe(true);
    expect(compare("", "exists", "")).toBe(false);
    expect(compare(undefined, "not_exists", "")).toBe(true);
    expect(compare("abc", "gt", "1")).toBe(false);
  });

  it("stops the run when the condition is false", async () => {
    const step = workflowInput.parse({
      name: "x",
      trigger: { type: "manual" },
      steps: [{ id: "f", name: "F", type: "filter", config: { left: "{{ trigger.body.amount }}", op: "gt", right: "500" } }],
    }).steps[0] as LeafStep;
    const result = await executeStep(step, scope);
    expect(result.kind).toBe("stop");
  });
});

describe("workflow validation", () => {
  it("rejects duplicate step ids and bad cron", () => {
    const res = workflowInput.safeParse({
      name: "x",
      trigger: { type: "schedule", cron: "nope" },
      steps: [
        { id: "a", name: "A", type: "log", config: { message: "hi" } },
        { id: "a", name: "B", type: "log", config: { message: "hi" } },
      ],
    });
    expect(res.success).toBe(false);
    const paths = res.error!.issues.map((i) => i.path.join("."));
    expect(paths).toContain("steps.1.id");
    expect(paths).toContain("trigger.cron");
  });

  it("fills in defaults", () => {
    const wf = workflowInput.parse({
      name: "x",
      trigger: { type: "manual" },
      steps: [{ id: "h", name: "H", type: "http", config: { url: "https://example.com" } }],
    });
    expect(wf.steps[0]).toMatchObject({ retry: { max: 0, backoffSeconds: 5 }, config: { method: "GET", failOnError: true } });
  });
});
