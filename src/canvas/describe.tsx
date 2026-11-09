import type { SVGProps } from "react";
import { STEP_TYPES } from "../../shared/examples";
import type { Step, Trigger } from "../../shared/schema";

/** What a node says about itself on the canvas: one short line, readable without opening the step. */

const OPS: Record<string, string> = {
  equals: "equals",
  not_equals: "does not equal",
  contains: "contains",
  gt: "is greater than",
  lt: "is less than",
  exists: "has a value",
  not_exists: "is empty",
};

/** `{{ trigger.body.amount }}` reads better on a node as `trigger.body.amount`. */
const bare = (text: string) => text.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, "$1").trim();

function condition(config: { left?: string; op?: string; right?: string }): string {
  const op = config.op ?? "";
  const tail = op.endsWith("exists") ? "" : ` ${bare(config.right ?? "")}`;
  return `${bare(config.left ?? "")} ${OPS[op] ?? op}${tail}`.trim();
}

function seconds(n: number): string {
  if (n < 60) return `${n} s`;
  if (n < 3600) return `${Math.round(n / 60)} min`;
  if (n < 86400) return `${Math.round(n / 360) / 10} h`;
  return `${Math.round(n / 8640) / 10} days`;
}

export function typeLabel(type: string): string {
  return STEP_TYPES.find((t) => t.type === type)?.label ?? type;
}

export function describeStep(step: Step): string {
  // Read loosely: step types added later (branches, loops, ready-made steps) still get a line.
  const config = (step.config ?? {}) as Record<string, unknown>;
  switch (step.type as string) {
    case "http": {
      const url = String(config.url ?? "").replace(/^https?:\/\//, "");
      return `${config.method ?? "GET"} ${url || "no URL yet"}`;
    }
    case "transform": {
      const output = config.output;
      if (output && typeof output === "object" && !Array.isArray(output)) {
        const keys = Object.keys(output);
        if (keys.length) return `Makes ${keys.join(", ")}`;
      }
      return typeof output === "string" && output ? bare(output) : "Reshapes data";
    }
    case "filter":
      return `Only if ${condition(config)}`;
    case "if":
      return condition(config);
    case "loop":
      return `Each item in ${bare(String(config.items ?? "")) || "a list"}`;
    case "delay":
      return `Waits ${seconds(Number(config.seconds) || 0)}`;
    case "log":
      return bare(String(config.message ?? ""));
    // Ready-made steps: what they post, never the credential field.
    case "slack":
      return `Posts ${bare(String(config.text ?? ""))}`;
    case "discord":
      return `Posts ${bare(String(config.content ?? ""))}`;
    case "telegram":
      return `To ${bare(String(config.chatId ?? "")) || "a chat"}: ${bare(String(config.text ?? ""))}`;
    case "github": {
      const repo = bare(String(config.repo ?? "")) || "a repository";
      if (config.action === "add_comment") return `Comments on ${repo} #${bare(String(config.number ?? ""))}`;
      if (config.action === "get_repo") return `Reads ${repo}`;
      return `Opens an issue in ${repo}`;
    }
    default: {
      const first = Object.values(config).find((v) => typeof v === "string" && v);
      return first ? bare(String(first)) : "";
    }
  }
}

export function describeTrigger(trigger: Trigger): { label: string; detail: string } {
  if (trigger.type === "schedule") return { label: "Schedule", detail: trigger.cron };
  if (trigger.type === "webhook") return { label: "Webhook", detail: "When a POST arrives" };
  return { label: "Manual", detail: "Started by hand" };
}

/** 16px glyphs for the node tiles, on the same 1.75 stroke as the app's icons. */
const paths: Record<string, React.ReactNode> = {
  manual: <path d="M5 3.5v9l7-4.5z" />,
  webhook: (
    <>
      <circle cx="8" cy="4" r="2" />
      <circle cx="3.5" cy="12" r="1.5" />
      <circle cx="12.5" cy="12" r="1.5" />
      <path d="M7 5.8 4.3 10.6M9 5.8l2.7 4.8" />
    </>
  ),
  schedule: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  http: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11" />
    </>
  ),
  transform: <path d="M6 2.5c-1.5 0-2 .7-2 2v2c0 .8-.5 1.5-1.5 1.5C3.500 8 4 8.700 4 9.500v2c0 1.300.5 2 2 2M10 2.5c1.500 0 2 .7 2 2v2c0 .8.5 1.500 1.500 1.500-1 0-1.500.7-1.500 1.500v2c0 1.300-.5 2-2 2" />,
  filter: <path d="M2.5 3.500h11L9.500 8.500v4l-3 1v-5z" />,
  delay: (
    <>
      <path d="M4.500 2.500h7M4.500 13.500h7M5 2.500c0 3 6 3.500 6 5.500s-6 2.500-6 5.500M11 2.500c0 3-6 3.500-6 5.500s6 2.500 6 5.500" />
    </>
  ),
  log: <path d="M3 4.500h10M3 8h10M3 11.500h6" />,
  if: (
    <>
      <path d="M8 2.500v4M8 6.500 4 10v3.500M8 6.500l4 3.500v3.500" />
    </>
  ),
  loop: <path d="M3 7a4 4 0 0 1 4-4h3.500M10.500 1 12.500 3l-2 2M13 9a4 4 0 0 1-4 4H5.500M5.500 15l-2-2 2-2" />,
  // Plain shapes, not the services' logos: a message bubble for the chat services, an issue dot for GitHub.
  slack: <path d="M3 3.500h10v7H7l-3 2.500v-2.500H3z" />,
  discord: <path d="M3 3.500h10v7H7l-3 2.500v-2.500H3z" />,
  telegram: <path d="M2.500 7.500 13.500 3l-2 10-3.500-3-2 2v-3.500l5.500-4" />,
  github: (
    <>
      <circle cx="8" cy="8" r="5.500" />
      <circle cx="8" cy="8" r="1.500" />
    </>
  ),
  other: <circle cx="8" cy="8" r="2.500" />,
};

export function Glyph({ type, ...rest }: { type: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {paths[type] ?? paths.other}
    </svg>
  );
}
