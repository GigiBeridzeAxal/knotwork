import { SLACK_HOST, SLACK_MAX_TEXT } from "../../shared/connectors/slack";
import type { Step } from "../../shared/schema";
import { type Budget, render, renderText } from "../../shared/template";
import type { Scope, StepOptions, StepResult } from "../steps";
import { callService, serviceUrl, tooLong } from "./common";

export async function slack(step: Extract<Step, { type: "slack" }>, scope: Scope, options: StepOptions, budget: Budget): Promise<StepResult> {
  const { config } = step;
  const hook = renderText(config.webhookUrl, scope, budget);
  const url = serviceUrl(hook, [SLACK_HOST], "Slack");
  if (typeof url === "string") return { kind: "fail", message: url };
  const text = renderText(config.text, scope, budget);
  if (!text.trim()) return { kind: "fail", message: "The Slack message came out empty" };
  if (text.length > SLACK_MAX_TEXT) return tooLong("Slack", "messages", SLACK_MAX_TEXT, text.length);
  const payload: Record<string, unknown> = { text };
  if (config.blocks !== undefined && config.blocks !== "") payload.blocks = render(config.blocks, scope, budget);

  const answer = await callService("Slack", url, { json: payload }, options, [hook], () => undefined);
  if (!answer.ok) return answer.result;
  return { kind: "ok", output: { ok: true, status: answer.status }, message: `Posted to Slack (${text.length} characters)` };
}
