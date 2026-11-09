import type { FilterOp, Step } from "../shared/schema";
import { render, renderString, renderText } from "../shared/template";

export type StepResult =
  | { kind: "ok"; output: unknown; message?: string }
  | { kind: "wait"; seconds: number; output: unknown; message: string }
  | { kind: "stop"; message: string }
  | { kind: "fail"; message: string; output?: unknown };

export interface Scope {
  trigger: unknown;
  steps: Record<string, unknown>;
  run: { id: string; startedAt: string };
  workflow: { id: string; name: string };
}

const HTTP_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = "Knotwork/0.1 (+https://github.com/GigiBeridzeAxal/knotwork)";

export async function executeStep(step: Step, scope: Scope): Promise<StepResult> {
  switch (step.type) {
    case "http":
      return http(step, scope);
    case "transform":
      return { kind: "ok", output: render(step.config.output, scope) };
    case "filter":
      return filter(step, scope);
    case "delay":
      return {
        kind: "wait",
        seconds: step.config.seconds,
        output: { waitedSeconds: step.config.seconds },
        message: `Waiting ${formatSeconds(step.config.seconds)}`,
      };
    case "log": {
      const message = renderText(step.config.message, scope);
      return { kind: "ok", output: { message }, message };
    }
  }
}

async function http(step: Extract<Step, { type: "http" }>, scope: Scope): Promise<StepResult> {
  const { config } = step;
  const url = renderText(config.url, scope).trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "fail", message: `"${url}" is not a valid URL` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { kind: "fail", message: "Only http and https URLs can be called" };
  }
  if (privateHost(parsed.hostname)) return { kind: "fail", message: `${parsed.hostname} is a private address, which steps can't call` };

  const headers = new Headers({ "user-agent": USER_AGENT });
  for (const [name, value] of Object.entries(config.headers)) {
    headers.set(name, renderText(value, scope));
  }

  let body: string | undefined;
  if (config.body !== undefined && config.body !== "" && config.method !== "GET") {
    if (typeof config.body === "string") {
      const rendered = renderString(config.body, scope);
      body = typeof rendered === "string" ? rendered : JSON.stringify(rendered);
    } else {
      body = JSON.stringify(render(config.body, scope));
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }

  // Redirects are followed by hand, so every hop is checked against private addresses too.
  let res: Response;
  const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  try {
    let target = parsed;
    let method: string = config.method;
    let sendBody = body;
    for (let hop = 0; ; hop++) {
      res = await fetch(target.toString(), { method, headers, body: sendBody, redirect: "manual", signal });
      const location = res.headers.get("location");
      if (res.status < 300 || res.status > 399 || !location) break;
      if (hop === MAX_REDIRECTS) return { kind: "fail", message: `${parsed.host} redirected more than ${MAX_REDIRECTS} times` };
      const next = new URL(location, target);
      if ((next.protocol !== "https:" && next.protocol !== "http:") || privateHost(next.hostname)) {
        return { kind: "fail", message: `${target.host} redirected to ${next.host}, which steps can't call` };
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        sendBody = undefined;
      }
      await res.body?.cancel();
      target = next;
    }
  } catch (err) {
    const reason = (err as Error).name === "TimeoutError" ? `timed out after ${HTTP_TIMEOUT_MS / 1000}s` : (err as Error).message;
    return { kind: "fail", message: `${config.method} ${parsed.host} failed: ${reason}` };
  }

  const text = await readLimited(res, MAX_RESPONSE_BYTES);
  let responseBody: unknown = text;
  if (text && (res.headers.get("content-type") ?? "").includes("json")) {
    try {
      responseBody = JSON.parse(text);
    } catch {
      // Not valid JSON after all; keep the text.
    }
  }
  const output = {
    status: res.status,
    ok: res.ok,
    headers: { "content-type": res.headers.get("content-type") ?? "" },
    body: responseBody,
  };
  const message = `${config.method} ${parsed.host}${parsed.pathname} → ${res.status}`;
  if (!res.ok && config.failOnError) return { kind: "fail", message, output };
  return { kind: "ok", output, message };
}

async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return text + "…[response cut off at 256 KB]";
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const OP_WORDS: Record<FilterOp, string> = {
  equals: "equals",
  not_equals: "does not equal",
  contains: "contains",
  gt: "is greater than",
  lt: "is less than",
  exists: "has a value",
  not_exists: "is empty",
};

function filter(step: Extract<Step, { type: "filter" }>, scope: Scope): StepResult {
  const { left, op, right } = step.config;
  const leftValue = renderString(left, scope);
  const rightText = renderText(right, scope);
  const passed = compare(leftValue, op, rightText);
  const shown = typeof leftValue === "string" ? `"${leftValue}"` : JSON.stringify(leftValue) ?? "nothing";
  const description = `${shown} ${OP_WORDS[op]}${op.endsWith("exists") ? "" : ` "${rightText}"`}`;
  if (!passed) return { kind: "stop", message: `Stopped: ${description} is false` };
  return { kind: "ok", output: { passed: true }, message: `Passed: ${description}` };
}

export function compare(left: unknown, op: FilterOp, right: string): boolean {
  const empty = left === undefined || left === null || left === "";
  switch (op) {
    case "exists":
      return !empty;
    case "not_exists":
      return empty;
    case "equals":
      return asText(left) === right;
    case "not_equals":
      return asText(left) !== right;
    case "contains":
      if (Array.isArray(left)) return left.some((item) => asText(item) === right);
      return asText(left).includes(right);
    case "gt":
    case "lt": {
      const a = Number(left);
      const b = Number(right);
      if (empty || Number.isNaN(a) || Number.isNaN(b)) return false;
      return op === "gt" ? a > b : a < b;
    }
  }
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 360) / 10}h`;
  return `${Math.round(seconds / 8640) / 10}d`;
}


/**
 * Hosts a step must not call: localhost, and literal IPs in private, loopback, link-local, CGNAT and
 * unique-local ranges. A Worker can't reach these in production anyway; this keeps it that way in
 * local development and documents the rule. Names that resolve to private IPs are left to the platform.
 */
export function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    if (host.startsWith("::ffff:")) return true;
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(host);
  }
  return false;
}
