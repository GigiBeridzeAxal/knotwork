import { describe, expect, it } from "vitest";
import { stepTestInput } from "../shared/schema";
import { clipTestOutput, testStep, toTestResult } from "../worker/stepTest";

const retry = { max: 0, backoffSeconds: 5 };

describe("testing one step", () => {
  it("runs a transform against the sample data", async () => {
    const res = await testStep(
      { id: "t", name: "T", type: "transform", retry, config: { output: { total: "{{ trigger.body.n }}", prev: "{{ steps.a.x }}", wf: "{{ workflow.name }}" } } },
      { trigger: { body: { n: 3 } }, steps: { a: { x: "y" } } },
      "Orders",
    );
    expect(res).toMatchObject({ status: "ok", message: null, output: { total: 3, prev: "y", wf: "Orders" } });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("says how long a delay would wait, without waiting", async () => {
    const started = Date.now();
    const res = await testStep({ id: "d", name: "D", type: "delay", retry, config: { seconds: 3600 } }, { steps: {} }, "W");
    expect(res.status).toBe("waiting");
    expect(res.message).toMatch(/1h/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reports a filter that stops", async () => {
    const res = await testStep({ id: "f", name: "F", type: "filter", retry, config: { left: "{{ trigger.n }}", op: "gt", right: "5" } }, { trigger: { n: 1 }, steps: {} }, "W");
    expect(res.status).toBe("stopped");
    expect(res.output).toBeNull();
  });

  it("turns a template over its budget into a failed test instead of an error", async () => {
    const res = await testStep(
      { id: "t", name: "T", type: "transform", retry, config: { output: Array.from({ length: 200 }, () => "{{ trigger }}") } },
      { trigger: "x".repeat(10_000), steps: {} },
      "W",
    );
    expect(res.status).toBe("failed");
    expect(res.message).toBeTruthy();
  });

  it("keeps the demo account to its allowed hosts and every account off private addresses", async () => {
    const http = (url: string) => ({ id: "h", name: "H", type: "http" as const, retry, config: { method: "GET" as const, url, headers: {}, failOnError: true } });
    const demo = await testStep(http("https://evil.example/x"), { steps: {} }, "W", { demo: true });
    expect(demo.status).toBe("failed");
    expect(demo.message).toMatch(/demo account can only call/);
    const local = await testStep(http("http://127.0.0.1/admin"), { steps: {} }, "W");
    expect(local).toMatchObject({ status: "failed", message: expect.stringMatching(/private address/) });
  });

  it("clips long messages and big outputs", () => {
    const res = toTestResult({ kind: "ok", output: "x".repeat(40_000), message: "m".repeat(5_000) }, 7);
    expect(res.message!.length).toBeLessThanOrEqual(1_001);
    expect(res.output).toMatch(/^The output was cut: it is 41 KB/);
    expect(res.durationMs).toBe(7);
    expect(clipTestOutput({ a: 1 })).toEqual({ a: 1 });
    expect(clipTestOutput(undefined)).toBeNull();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(clipTestOutput(loop)).toMatch(/can't be shown/);
  });

  it("validates the request body", () => {
    expect(stepTestInput.safeParse({ step: { id: "Bad id", name: "x", type: "log", config: { message: "" } } }).success).toBe(false);
    expect(stepTestInput.safeParse({}).success).toBe(false);
    const ok = stepTestInput.parse({ step: { id: "a", name: "A", type: "log", config: { message: "hi" } } });
    expect(ok.sample).toEqual({ steps: {} });
    expect(ok.workflowName).toBe("Untitled workflow");
  });
});
