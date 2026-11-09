import type { Step, StepSample, StepTestResult } from "../shared/schema";
import { redactor, secretRefs } from "./secrets";
import { clip, DEMO_HOSTS, evaluateIf, executeStep, loopItems, type Scope, type StepResult } from "./steps";

/**
 * Testing one step from the editor: the step runs once against sample data and the answer goes
 * straight back. Nothing is stored, and a delay step only says how long it would wait.
 *
 * The step goes through executeStep, so every protection a real run has applies here too: the
 * private-address check on the URL and on every redirect hop, the demo account's host allow-list, the
 * 15 s timeout, the 256 KB response cap and the 64 KB budget for rendered templates. The route sits
 * behind the session check, the same-origin check and the per-IP limiter like every other API route,
 * and has its own hourly limit (LIMITS.stepTestsPerHour).
 */

/** The most of a step's message a test shows (characters). */
export const TEST_MESSAGE_CHARS = 1_000;
/** The most of a step's output a test shows (UTF-8 bytes of JSON). */
export const TEST_OUTPUT_BYTES = 32_000;

const STATUS: Record<StepResult["kind"], StepTestResult["status"]> = {
  ok: "ok",
  fail: "failed",
  stop: "stopped",
  wait: "waiting",
};

/**
 * A step's output, as a test may show it: plain JSON of at most `max` bytes. A bigger output, or one
 * that can't be turned into JSON, becomes a short note saying so, instead of a huge answer.
 */
export function clipTestOutput(output: unknown, max = TEST_OUTPUT_BYTES): unknown {
  if (output === undefined) return null;
  let text: string;
  try {
    text = JSON.stringify(output) ?? "null";
  } catch (err) {
    return `The output can't be shown: ${clip((err as Error).message, 200)}`;
  }
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > max) {
    return `The output was cut: it is ${Math.ceil(bytes / 1000)} KB, and a test shows at most ${max / 1000} KB.`;
  }
  return JSON.parse(text);
}

/** What a step's result looks like to the editor. */
export function toTestResult(result: StepResult, durationMs: number): StepTestResult {
  const output = "output" in result ? result.output : null;
  return {
    status: STATUS[result.kind],
    message: result.message === undefined ? null : clip(result.message, TEST_MESSAGE_CHARS),
    output: clipTestOutput(output),
    durationMs,
  };
}

/**
 * Runs one step against `sample`. Never throws: a step that throws (a template over its budget, or
 * anything else) is a failed test with the error's message, not a server error.
 */
export async function testStep(
  step: Step,
  sample: StepSample,
  workflowName: string,
  {
    demo = false,
    now = Date.now(),
    secrets = {},
    unreadable = new Set<string>(),
  }: {
    demo?: boolean;
    now?: number;
    /** The workspace secrets the step names, already decrypted. They are hidden in the answer, as in a run. */
    secrets?: Record<string, string>;
    /** Names that are saved but can't be decrypted (the server's key changed). */
    unreadable?: Set<string>;
  } = {},
): Promise<StepTestResult> {
  const missing = [...secretRefs(step.config)].filter((name) => !Object.hasOwn(secrets, name));
  const lost = missing.filter((name) => unreadable.has(name));
  if (lost.length) {
    return toTestResult(
      {
        kind: "fail",
        message: `The secret ${lost.join(", ")} is saved but can't be read any more (the server's key changed). Set its value again under Settings, then Secrets.`,
      },
      0,
    );
  }
  if (missing.length) {
    return toTestResult(
      { kind: "fail", message: `The secret ${missing.join(", ")} isn't set in this workspace. Add it under Settings, then Secrets.` },
      0,
    );
  }
  const clean = redactor(secrets);
  const scope: Scope = {
    trigger: sample.trigger ?? {},
    steps: sample.steps,
    run: { id: "run_test", startedAt: new Date(now).toISOString() },
    workflow: { id: "wf_test", name: workflowName },
    secrets,
    ...(sample.loop ? { loop: { item: sample.loop.item, index: sample.loop.index, count: sample.loop.count, items: [] } } : {}),
  };
  const started = Date.now();
  let result: StepResult;
  try {
    if (step.type === "if") {
      // A block is tested on its own: an "if" says which way it would go, a loop what it would go through.
      const { passed, message } = evaluateIf(step, scope);
      result = { kind: "ok", output: { result: passed, branch: passed ? "then" : "else" }, message };
    } else if (step.type === "loop") {
      const list = loopItems(step, scope);
      result =
        "problem" in list
          ? { kind: "fail", message: list.problem }
          : {
              kind: "ok",
              output: { count: list.items.length, index: 0, item: list.items[0] },
              message: `Would go through ${list.items.length} ${list.items.length === 1 ? "item" : "items"}`,
            };
    } else {
      result = await executeStep(step, scope, demo ? { allowHosts: DEMO_HOSTS } : {});
    }
  } catch (err) {
    result = { kind: "fail", message: (err as Error)?.message || "The step crashed" };
  }
  if ("message" in result && result.message !== undefined) result = { ...result, message: clean(result.message) };
  if ("output" in result) result = { ...result, output: clean(result.output) } as StepResult;
  return toTestResult(result, Date.now() - started);
}
