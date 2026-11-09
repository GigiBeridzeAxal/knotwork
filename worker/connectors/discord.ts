import { DISCORD_HOSTS, DISCORD_MAX_CONTENT } from "../../shared/connectors/discord";
import type { Step } from "../../shared/schema";
import { type Budget, renderText } from "../../shared/template";
import type { Scope, StepOptions, StepResult } from "../steps";
import { callService, field, missingCredential, serviceUrl, tooLong } from "./common";

export async function discord(step: Extract<Step, { type: "discord" }>, scope: Scope, options: StepOptions, budget: Budget): Promise<StepResult> {
  const { config } = step;
  const hook = renderText(config.webhookUrl, scope, budget);
  const missing = missingCredential("Discord", "webhook URL", config.webhookUrl, hook);
  if (missing) return { kind: "fail", message: missing };
  const url = serviceUrl(hook, DISCORD_HOSTS, "Discord", "/api/webhooks/");
  if (typeof url === "string") return { kind: "fail", message: url };
  const hidden = [hook, url.href, url.pathname];
  // wait=true makes Discord answer with the message it posted, so later steps can use its id.
  url.searchParams.set("wait", "true");
  const content = renderText(config.content, scope, budget);
  if (!content.trim()) return { kind: "fail", message: "The Discord message came out empty" };
  if (content.length > DISCORD_MAX_CONTENT) return tooLong("Discord", "messages", DISCORD_MAX_CONTENT, content.length);
  const username = renderText(config.username, scope, budget).trim().slice(0, 80);
  // Text from a webhook or an API must not be able to ping @everyone or a role; mentions of users still work.
  const payload: Record<string, unknown> = { content, allowed_mentions: { parse: ["users"] } };
  if (username) payload.username = username;

  const answer = await callService("Discord", url, { json: payload }, options, hidden, (body) => {
    const message = field(body, "message");
    return typeof message === "string" ? message : undefined;
  });
  if (!answer.ok) return answer.result;
  return {
    kind: "ok",
    output: { ok: true, messageId: field(answer.body, "id") ?? null, channelId: field(answer.body, "channel_id") ?? null },
    message: `Posted to Discord (${content.length} characters)`,
  };
}
