import { clip, send, type StepOptions, type StepResult } from "../steps";

/** Checks a rendered URL is https on one of the hosts a ready-made step may call. Never echoes the URL. */
export function serviceUrl(text: string, hosts: readonly string[], service: string, pathPrefix = "/"): URL | string {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return `The ${service} webhook URL isn't a valid URL`;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || !hosts.includes(host) || url.port !== "" || url.username || url.password) {
    return `The ${service} webhook URL must start with https://${hosts[0]}`;
  }
  if (!url.pathname.startsWith(pathPrefix)) return `The ${service} webhook URL must start with https://${hosts[0]}${pathPrefix}`;
  return url;
}

/** Hides credentials in a message, in case a service or the network ever repeats one back. */
export function hide(message: string, secrets: string[]): string {
  let out = message;
  for (const secret of secrets) if (secret.length >= 6) out = out.split(secret).join("•••");
  return out;
}

export type Answer = { ok: true; status: number; body: unknown } | { ok: false; result: StepResult };

/**
 * POSTs (or GETs) JSON to a service with the http step's guards and no redirects. A failed answer
 * becomes a failed step whose message is what the service said, cut short.
 */
export async function callService(
  service: string,
  url: URL,
  init: { method?: string; headers?: Record<string, string>; json?: unknown },
  options: StepOptions,
  secrets: string[],
  reason: (body: unknown) => string | undefined,
): Promise<Answer> {
  const headers = new Headers(init.headers);
  let body: string | undefined;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers.set("content-type", "application/json");
  }
  const sent = await send({ method: init.method ?? "POST", url, headers, body, maxRedirects: 0 }, options);
  if (sent.kind === "fail") return { ok: false, result: { kind: "fail", message: hide(sent.message, secrets) } };
  const { res } = sent;
  if (!res.ok) {
    const said = reason(sent.body) ?? (typeof sent.body === "string" ? sent.body : "");
    const detail = said ? `: ${clip(hide(said, secrets), 300)}` : "";
    const wait = res.headers.get("retry-after");
    const later = res.status === 429 && wait ? ` (asked to wait ${clip(wait, 20)}s)` : "";
    return {
      ok: false,
      result: { kind: "fail", message: `${service} answered ${res.status}${detail}${later}`, output: { status: res.status, ok: false } },
    };
  }
  return { ok: true, status: res.status, body: sent.body };
}

/** A field of an object answer, or undefined. */
export function field(body: unknown, key: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

export const tooLong = (service: string, what: string, max: number, length: number): StepResult => ({
  kind: "fail",
  message: `${service} ${what} can be at most ${max.toLocaleString("en-US")} characters; this one is ${length.toLocaleString("en-US")}`,
});
