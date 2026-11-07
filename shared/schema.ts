import { z } from "zod";
import { validateCron } from "./cron";

/** A step id is how later steps refer to this step's output: `{{ steps.<id>.body }}`. */
const stepId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "Use lowercase letters, digits and _, starting with a letter");

const retry = z
  .object({
    /** Extra attempts after the first one fails. */
    max: z.number().int().min(0).max(5).default(0),
    /** Wait before the first retry; each later retry waits four times longer. */
    backoffSeconds: z.number().int().min(1).max(3600).default(5),
  })
  .default({ max: 0, backoffSeconds: 5 });

const base = {
  id: stepId,
  name: z.string().trim().min(1, "Give it a name").max(80),
  retry,
};

export const httpStep = z.object({
  ...base,
  type: z.literal("http"),
  config: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    url: z.string().min(1).max(2000),
    headers: z.record(z.string(), z.string()).default({}),
    /** A string, or any JSON value; templates work inside either. Sent as JSON unless it's a string. */
    body: z.unknown().optional(),
    /** Treat a 4xx or 5xx answer as a failure (and retry it). */
    failOnError: z.boolean().default(true),
  }),
});

export const transformStep = z.object({
  ...base,
  type: z.literal("transform"),
  config: z.object({
    /** Any JSON value. Every string in it is a template; the result is this step's output. */
    output: z.unknown(),
  }),
});

export const filterOps = ["equals", "not_equals", "contains", "gt", "lt", "exists", "not_exists"] as const;

export const filterStep = z.object({
  ...base,
  type: z.literal("filter"),
  config: z.object({
    left: z.string().max(500),
    op: z.enum(filterOps),
    right: z.string().max(500).default(""),
  }),
});

export const delayStep = z.object({
  ...base,
  type: z.literal("delay"),
  config: z.object({
    seconds: z.number().int().min(1).max(7 * 24 * 3600),
  }),
});

export const logStep = z.object({
  ...base,
  type: z.literal("log"),
  config: z.object({
    message: z.string().max(2000),
  }),
});

export const stepSchema = z.discriminatedUnion("type", [
  httpStep,
  transformStep,
  filterStep,
  delayStep,
  logStep,
]);

export const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({ type: z.literal("webhook") }),
  z.object({
    type: z.literal("schedule"),
    cron: z
      .string()
      .trim()
      .max(100)
      .superRefine((cron, ctx) => {
        const problem = validateCron(cron);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      }),
  }),
]);

export const MAX_STEPS = 25;

export const workflowInput = z
  .object({
    name: z.string().trim().min(1, "Give it a name").max(80),
    description: z.string().max(500).default(""),
    enabled: z.boolean().default(true),
    trigger: triggerSchema,
    steps: z.array(stepSchema).max(MAX_STEPS),
  })
  .superRefine((wf, ctx) => {
    const seen = new Set<string>();
    wf.steps.forEach((step, i) => {
      if (seen.has(step.id)) {
        ctx.addIssue({ code: "custom", path: ["steps", i, "id"], message: `Step id "${step.id}" is used twice` });
      }
      seen.add(step.id);
    });
  });

export type Step = z.infer<typeof stepSchema>;
export type StepType = Step["type"];
export type Trigger = z.infer<typeof triggerSchema>;
export type WorkflowInput = z.infer<typeof workflowInput>;
export type FilterOp = (typeof filterOps)[number];

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "stopped";
export type LogStatus = "ok" | "failed" | "retrying" | "stopped" | "waiting";

export interface Workflow extends WorkflowInput {
  id: string;
  hookKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowSummary extends Workflow {
  lastRun: { id: string; status: RunStatus; createdAt: number } | null;
}

export interface Run {
  id: string;
  workflowId: string;
  workflowName?: string;
  status: RunStatus;
  triggerType: Trigger["type"];
  input: unknown;
  stepIndex: number;
  attempt: number;
  nextRunAt: number | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface StepLog {
  id: number;
  stepId: string;
  stepName: string;
  stepType: StepType;
  attempt: number;
  status: LogStatus;
  message: string | null;
  output: unknown;
  startedAt: number;
  durationMs: number;
}

export interface RunDetail extends Run {
  logs: StepLog[];
  stepCount: number;
}
