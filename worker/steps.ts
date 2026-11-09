import { LIMITS } from "../shared/limits";
import type { FilterOp, IfStep, LeafStep, LoopStep, Step } from "../shared/schema";
import { type Budget, newBudget, render, renderString, renderText } from "../shared/template";
import { secretRefs } from "./secrets";

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
  /** The workspace secrets this run's steps mention, by name. */
  secrets: Record<string, string>;
  /** Inside a loop: the innermost loop's current item, its position (from 0) and the list's length. */
  loop?: LoopFrame;
}

/** What a loop's own output holds while it runs; afterwards only `count` is left. */
export interface LoopFrame {
  item: unknown;
  index: number;
  count: number;
  items: unknown[];
}

const HTTP_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = "Knotwork/0.1 (+https://github.com/GigiBeridzeAxal/knotwork)";

/**
 * Hosts the shared demo account's http steps may call. Anyone can open the demo without an account,
 * so it must not be a free, anonymous way to send requests anywhere.
 */
export const DEMO_HOSTS = ["api.github.com", "httpbin.org", "jsonplaceholder.typicode.com", "postman-echo.com", "example.com"];

export interface StepOptions {
  /** When set, http steps may only call these hosts. */
  allowHosts?: readonly string[];
}

/**
 * The same scope with each secret's value swapped for its mark, `[secret NAME]`. Everything a step
 * says about itself (log lines, errors) is written from this copy, so a secret never reaches a message
 * in any shape: whole, cut short, or taken apart by the URL parser. (Outputs still go through the
 * engine's redactor; this covers what the redactor can't recognise.)
 */
function forShow(scope: Scope): Scope {
  const names = Object.keys(scope.secrets);
  if (!names.length) return scope;
  return { ...scope, secrets: Object.fromEntries(names.map((name) => [name, `[secret ${name}]`])) };
}

/** Cuts text that will be stored or shown (log lines, errors), so no step can make them huge. */
export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Runs one step that isn't a block. (The engine walks `if` and `loop` itself, with the two functions below.) */
export async function executeStep(step: LeafStep, scope: Scope, options: StepOptions = {}): Promise<StepResult> {
  // One budget for everything this step renders (URL, headers, body, output, message).
  const budget = newBudget();
  switch (step.type) {
    case "http":
      return http(step, scope, options, budget);
    case "transform":
      return { kind: "ok", output: render(step.config.output, scope, budget) };
    case "filter":
      return filter(step, scope, budget);
    case "delay":
      return {
        kind: "wait",
        seconds: step.config.seconds,
        output: { waitedSeconds: step.config.seconds },
        message: `Waiting ${formatSeconds(step.config.seconds)}`,
      };
    case "log": {
      const message = renderText(step.config.message, scope, budget);
      const show = forShow(scope);
      const shown = show === scope ? message : renderText(step.config.message, show, newBudget());
      return { kind: "ok", output: { message }, message: clip(shown, 2_000) };
    }
  }
}

/** Headers that carry credentials. They're dropped when a redirect leads to another host. */
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie", "x-api-key"];

const MAX_URL = 2_048;

async function http(step: Extract<Step, { type: "http" }>, scope: Scope, options: StepOptions, budget: Budget): Promise<StepResult> {
  const { config } = step;
  const url = renderText(config.url, scope, budget).trim();
  if (url.length > MAX_URL) return { kind: "fail", message: `The URL is longer than ${MAX_URL} characters` };
  // How the address is written in log lines and errors: with secrets as their marks.
  const show = forShow(scope);
  const shownUrl = show === scope ? url : renderText(config.url, show, newBudget()).trim();
  // Host and path as written (the parser would percent-encode a mark); the query stays out, as always.
  const written = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/i.exec(shownUrl);
  // No scheme and host to be seen: the address, or its start, is a secret. It is shown as its mark.
  const shownHost = written ? written[1].replace(/^.*@/, "") : clip(shownUrl.split(/[?#]/)[0], 200);
  const shownPath = written ? clip(written[2], 200) : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "fail", message: `"${clip(shownUrl, 200)}" is not a valid URL` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { kind: "fail", message: "Only http and https URLs can be called" };
  }
  if (privateHost(parsed.hostname)) return { kind: "fail", message: `${shownHost} is a private address, which steps can't call` };
  const blocked = notAllowed(parsed.hostname, options);
  if (blocked) return { kind: "fail", message: blocked };

  const headers = new Headers({ "user-agent": USER_AGENT });
  for (const [name, value] of Object.entries(config.headers)) {
    headers.set(name, renderText(value, scope, budget));
  }
  // What was filled in from a secret is meant for the address the step names, and nobody else.
  const secretHeaders = Object.entries(config.headers).filter(([, value]) => secretRefs(value).size).map(([name]) => name);
  const secretBody = secretRefs(config.body).size > 0;

  let body: string | undefined;
  if (config.body !== undefined && config.body !== "" && config.method !== "GET") {
    if (typeof config.body === "string") {
      const rendered = renderString(config.body, scope, budget);
      body = typeof rendered === "string" ? rendered : JSON.stringify(rendered);
    } else {
      body = JSON.stringify(render(config.body, scope, budget));
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
      if (hop === MAX_REDIRECTS) return { kind: "fail", message: `${shownHost} redirected more than ${MAX_REDIRECTS} times` };
      const next = new URL(location, target);
      if ((next.protocol !== "https:" && next.protocol !== "http:") || privateHost(next.hostname) || notAllowed(next.hostname, options)) {
        return { kind: "fail", message: `${hop === 0 ? shownHost : target.host} redirected to ${next.host}, which steps can't call` };
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        sendBody = undefined;
      }
      // Credentials set for one origin must not be handed to another one (another host, or http).
      if (next.origin !== target.origin) {
        for (const name of [...CREDENTIAL_HEADERS, ...secretHeaders]) headers.delete(name);
        if (secretBody && sendBody !== undefined) {
          await res.body?.cancel();
          return {
            kind: "fail",
            message: `${hop === 0 ? shownHost : target.host} redirected to ${next.host}; the body holds a secret, so it was not sent on`,
          };
        }
      }
      await res.body?.cancel();
      target = next;
    }
  } catch (err) {
    const reason = (err as Error).name === "TimeoutError" ? `timed out after ${HTTP_TIMEOUT_MS / 1000}s` : (err as Error).message;
    return { kind: "fail", message: `${config.method} ${shownHost} failed: ${reason}` };
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
  const message = `${config.method} ${shownHost}${shownPath} → ${res.status}`;
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

/** Works out a condition (a filter's, or an if's) and puts it in words for the log. */
function check(config: { left: string; op: FilterOp; right: string }, scope: Scope, budget: Budget) {
  const { left, op, right } = config;
  const leftValue = renderString(left, scope, budget);
  const rightText = renderText(right, scope, budget);
  const passed = compare(leftValue, op, rightText);
  // Put in words from the copy with secrets as marks, so cutting the text can't leave part of one.
  const show = forShow(scope);
  const leftShown = show === scope ? leftValue : renderString(left, show, newBudget());
  const rightShown = show === scope ? rightText : renderText(right, show, newBudget());
  const shown = clip(typeof leftShown === "string" ? `"${leftShown}"` : JSON.stringify(leftShown) ?? "nothing", 300);
  const description = `${shown} ${OP_WORDS[op]}${op.endsWith("exists") ? "" : ` "${clip(rightShown, 300)}"`}`;
  return { passed, description };
}

function filter(step: Extract<Step, { type: "filter" }>, scope: Scope, budget: Budget): StepResult {
  const { passed, description } = check(step.config, scope, budget);
  if (!passed) return { kind: "stop", message: `Stopped: ${description} is false` };
  return { kind: "ok", output: { passed: true }, message: `Passed: ${description}` };
}

/** Which branch an `if` takes. Its output is `{ result, branch }`, so later steps can ask `{{ steps.<id>.result }}`. */
export function evaluateIf(step: IfStep, scope: Scope): { passed: boolean; message: string } {
  const { passed, description } = check(step.config, scope, newBudget());
  const branch = passed ? step.then : step.else;
  const name = passed ? "Then" : "Else";
  const runs = branch.length === 0 ? `${name} is empty` : `${name} runs (${branch.length} ${branch.length === 1 ? "step" : "steps"})`;
  return { passed, message: `${passed ? "True" : "False"}: ${description}. ${runs}` };
}

/**
 * The list a loop goes through, or why it can't. The template must give a list itself
 * (`{{ trigger.body.orders }}`); text that happens to look like one is not parsed.
 */
export function loopItems(step: LoopStep, scope: Scope): { items: unknown[] } | { problem: string } {
  const value = renderString(step.config.items.trim(), scope, newBudget());
  if (!Array.isArray(value)) {
    const got = value === undefined || value === null || value === "" ? "nothing" : typeof value === "object" ? "an object" : `${typeof value === "string" ? "text" : `a ${typeof value}`}`;
    return { problem: `${clip(step.config.items, 200)} gave ${got}, not a list` };
  }
  if (value.length > LIMITS.loopItems) {
    return { problem: `The list has ${value.length} items, and a loop can go through at most ${LIMITS.loopItems}` };
  }
  return { items: value };
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


function notAllowed(hostname: string, options: StepOptions): string | null {
  if (!options.allowHosts) return null;
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (options.allowHosts.includes(host)) return null;
  return `The demo account can only call ${options.allowHosts.join(", ")}. Create a free account to call ${host}.`;
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
    // IPv4-mapped and IPv4-compatible (::/96), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) addresses
    // all lead to an IPv4 address, which may be a private one.
    if (/^::(ffff:)?[0-9a-f.:]+$/.test(host)) return true;
    if (host.startsWith("64:ff9b:") || host.startsWith("2002:")) return true;
    // Unique-local (fc00::/7), link-local (fe80::/10) and the old site-local (fec0::/10).
    return /^(fc|fd|fe[89a-f])/.test(host);
  }
  return false;
}
