import { SLACK_HOST, SLACK_MAX_TEXT } from "../../shared/connectors/slack";
import type { Step } from "../../shared/schema";
import { type Budget, render, renderText } from "../../shared/template";
import type { Scope, StepOptions, StepResult } from "../steps";
import { callService, missingCredential, serviceUrl, tooLong } from "./common";

export async function slack(step: Extract<Step, { type: "slack" }>, scope: Scope, options: StepOptions, budget: Budget): Promise<StepResult> {
  const { config } = step;
  const hook = renderText(config.webhookUrl, scope, budget);
  const missing = missingCredential("Slack", "webhook URL", config.webhookUrl, hook);
  if (missing) return { kind: "fail", message: missing };
  const url = serviceUrl(hook, [SLACK_HOST], "Slack");
  if (typeof url === "string") return { kind: "fail", message: url };
  let text = renderText(config.text, scope, budget);
  // Like Discord's: text from a webhook or an API must not be able to ping the whole channel or a group.
  if (!config.mentions) text = quietSlack(text);
  if (!text.trim()) return { kind: "fail", message: "The Slack message came out empty" };
  if (text.length > SLACK_MAX_TEXT) return tooLong("Slack", "messages", SLACK_MAX_TEXT, text.length);
  const payload: Record<string, unknown> = { text };
  if (config.blocks !== undefined && config.blocks !== "") {
    const blocks = render(config.blocks, scope, budget);
    payload.blocks = config.mentions ? blocks : quietEach(blocks);
  }

  const answer = await callService("Slack", url, { json: payload }, options, [hook, url.href, url.pathname], () => undefined);
  if (!answer.ok) return answer.result;
  return { kind: "ok", calls: answer.calls, output: { ok: true, status: answer.status }, message: `Posted to Slack (${text.length} characters)` };
}

/** Turns Slack's channel-wide and group mentions into plain text. */
export function quietSlack(text: string): string {
  return text.replace(/<!(channel|here|everyone)(\|[^>]*)?>/gi, "@$1").replace(/<!subteam\^[^>]*>/gi, "@group");
}

/** quietSlack on every string inside the blocks, so a mention can't be split across two fields. */
function quietEach(value: unknown): unknown {
  if (typeof value === "string") return quietSlack(value);
  if (Array.isArray(value)) return value.map(quietEach);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, quietEach(v)]));
  return value;
}
