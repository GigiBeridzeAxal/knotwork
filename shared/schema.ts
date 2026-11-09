import { z } from "zod";
import { minutesBetweenRuns, validateCron } from "./cron";
import { LIMITS } from "./limits";

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
        if (problem) return ctx.addIssue({ code: "custom", message: problem });
        if (minutesBetweenRuns(cron) < LIMITS.minScheduleMinutes) {
          ctx.addIssue({ code: "custom", message: `Schedules can run at most every ${LIMITS.minScheduleMinutes} minutes` });
        }
      }),
  }),
]);

export const MAX_STEPS = LIMITS.stepsPerWorkflow;

export const workflowInput = z
  .object({
    name: z.string().trim().min(1, "Give it a name").max(80),
    description: z.string().max(500).default(""),
    enabled: z.boolean().default(true),
    trigger: triggerSchema,
    steps: z.array(stepSchema).max(MAX_STEPS),
  })
  .superRefine((wf, ctx) => {
    if (JSON.stringify(wf).length > LIMITS.workflowBytes) {
      ctx.addIssue({ code: "custom", path: ["steps"], message: `A workflow can be at most ${LIMITS.workflowBytes / 1000} KB. Trim long step settings.` });
    }
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

/** Saving sends the version it was loaded at; a newer version on the server means someone else saved first. */
export const workflowSave = z.object({ version: z.number().int().min(0) });

export interface Workflow extends WorkflowInput {
  id: string;
  workspaceId: string;
  hookKey: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  /** `error: "space"` when the storage guard stopped it. */
  lastRun: { id: string; status: RunStatus; createdAt: number; error?: string } | null;
}

/** A workflow as lists show it: each step's name and type, without its settings. */
export type WorkflowSummary = Omit<Workflow, "steps"> & { steps: Pick<Step, "id" | "name" | "type">[] };

// ---------- Accounts ----------

const email = z.string().trim().toLowerCase().max(254).email("Enter an email address like name@example.com");
export const PASSWORD_MIN = 10;

const newPassword = z.string().min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`).max(200);

export const signupInput = z.object({
  name: z.string().trim().min(1, "Tell us what to call you").max(60),
  email,
  password: newPassword,
});

export const passwordChange = z.object({
  current: z.string().min(1, "Enter your current password").max(200),
  next: newPassword,
});

export const accountDelete = z.object({ password: z.string().min(1, "Enter your password").max(200) });

export const loginInput = z.object({
  email,
  password: z.string().min(1, "Enter your password").max(200),
});

export const workspaceInput = z.object({
  name: z.string().trim().min(1, "Give it a name").max(40),
});

export interface User {
  id: string;
  name: string;
  email: string;
  /** The shared demo account: anyone can sign in to it, and it is reset every day. */
  demo: boolean;
}

/** What someone may do in a workspace. Its owner made it; editors and viewers joined by an invite link. */
export const ROLES = ["owner", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];
/** The roles an invite link or a role change can give. A workspace keeps the one owner it started with. */
export const memberRole = z.enum(["editor", "viewer"]);
export type MemberRole = z.infer<typeof memberRole>;
/** Viewers only read. Everything that changes a workflow or starts a run needs an editor or the owner. */
export const canEdit = (role: Role) => role === "owner" || role === "editor";

export interface Workspace {
  id: string;
  name: string;
  /** Every account has one personal workspace. It can be renamed but not deleted, and it isn't shared. */
  personal: boolean;
  createdAt: number;
  /** The signed-in user's role here: "owner" for their own workspaces. */
  role: Role;
}

export interface Me {
  user: User;
  /** The user's own workspaces first, then the ones they joined. */
  workspaces: Workspace[];
  /** Unused recovery codes left (0 when none were ever made). */
  recoveryCodesLeft: number;
}

// ---------- Recovery codes ----------

/** A recovery code as typed: 12 letters and digits, with or without the dashes, in either case. */
export const recoveryCode = z
  .string()
  .trim()
  .max(40)
  .transform((code) => code.toUpperCase().replace(/[\s-]/g, ""))
  .refine((code) => /^[0-9A-Z]{12}$/.test(code), "A recovery code looks like ABCD-EFGH-JKMN");

export const recoverInput = z.object({ email, code: recoveryCode, password: newPassword });
export const recoveryCodesInput = z.object({ password: z.string().min(1, "Enter your password").max(200) });

// ---------- Teams ----------

export const inviteInput = z.object({ role: memberRole });
export const inviteToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const roleChange = z.object({ role: memberRole });

export interface Member {
  userId: string;
  name: string;
  role: Role;
  joinedAt: number;
  /** True for the signed-in user's own row. */
  you: boolean;
}

/** An open invite link. The link itself is only returned once, when it is made. */
export interface Invite {
  id: string;
  role: MemberRole;
  createdAt: number;
  expiresAt: number;
  /** People who joined with it so far, and the most it lets in. */
  uses: number;
  maxUses: number;
}

export interface NewInvite extends Invite {
  /** The secret in the link: `/join/<token>`. Not stored; it can't be shown again. */
  token: string;
}

/** What someone holding an invite link sees before joining. */
export interface InvitePreview {
  workspaceId: string;
  workspaceName: string;
  ownerName: string;
  role: MemberRole;
  /** True when the signed-in user already owns or belongs to the workspace. */
  already: boolean;
}

export interface Team {
  members: Member[];
  /** Open invite links. Only the owner gets these; for everyone else the list is empty. */
  invites: Invite[];
}

// ---------- API keys ----------

export const apiKeyAccess = z.enum(["read", "write"]);
export type ApiKeyAccess = z.infer<typeof apiKeyAccess>;

export const apiKeyInput = z.object({
  name: z.string().trim().min(1, "Give it a name").max(40),
  workspaceId: z.string().min(1).max(60),
  access: apiKeyAccess,
});

/** An API key as lists show it. The key itself is only returned once, when it is made. */
export interface ApiKey {
  id: string;
  name: string;
  workspaceId: string;
  access: ApiKeyAccess;
  /** The first characters of the key, to tell keys apart. */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface NewApiKey extends ApiKey {
  /** The whole key, e.g. `kw_…`. Not stored; it can't be shown again. */
  key: string;
}

export interface Run {
  id: string;
  workflowId: string;
  workflowName?: string;
  status: RunStatus;
  triggerType: Trigger["type"];
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
  /** What started the run: the webhook request, the manual test input, or the scheduled minute. */
  input: unknown;
  logs: StepLog[];
  stepCount: number;
}

export interface Overview {
  workflows: WorkflowSummary[];
  /** The workspace's newest 100 runs. */
  runs: Run[];
  /** Runs the whole account started this clock hour (the limit is per account). */
  runsThisHour: number;
  /** This account's hourly run limit right now (lower in its first 24 hours). */
  runsLimit: number;
}
