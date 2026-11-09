import { TELEGRAM_HOST, TELEGRAM_MAX_TEXT } from "../../shared/connectors/telegram";
import type { Step } from "../../shared/schema";
import { type Budget, renderText } from "../../shared/template";
import type { Scope, StepOptions, StepResult } from "../steps";
import { callService, field, missingCredential, tooLong } from "./common";

const BOT_TOKEN = /^\d{3,20}:[A-Za-z0-9_-]{20,100}$/;
const CHAT_ID = /^(-?\d{1,20}|@[A-Za-z0-9_]{4,64})$/;

export async function telegram(step: Extract<Step, { type: "telegram" }>, scope: Scope, options: StepOptions, budget: Budget): Promise<StepResult> {
  const { config } = step;
  const token = renderText(config.botToken, scope, budget).trim();
  const missing = missingCredential("Telegram", "bot token", config.botToken, token);
  if (missing) return { kind: "fail", message: missing };
  // Never echo the token, not even part of it.
  if (!BOT_TOKEN.test(token)) return { kind: "fail", message: "The Telegram bot token doesn't look like one from @BotFather (digits, a colon, then letters)" };
  const chatId = renderText(config.chatId, scope, budget).trim();
  if (!CHAT_ID.test(chatId)) return { kind: "fail", message: "The Telegram chat id must be a number (like -1001234567890) or @channelname" };
  const text = renderText(config.text, scope, budget);
  if (!text.trim()) return { kind: "fail", message: "The Telegram message came out empty" };
  if (text.length > TELEGRAM_MAX_TEXT) return tooLong("Telegram", "messages", TELEGRAM_MAX_TEXT, text.length);

  const url = new URL(`https://${TELEGRAM_HOST}/bot${token}/sendMessage`);
  const payload: Record<string, unknown> = { chat_id: chatId, text, disable_notification: config.silent };
  if (config.parseMode) payload.parse_mode = config.parseMode;

  const answer = await callService("Telegram", url, { json: payload }, options, [token], (body) => {
    const description = field(body, "description");
    return typeof description === "string" ? description : undefined;
  });
  if (!answer.ok) return answer.result;
  const result = field(answer.body, "result");
  return {
    kind: "ok",
    output: { ok: true, messageId: field(result, "message_id") ?? null, chatId: field(field(result, "chat"), "id") ?? chatId },
    message: `Sent to Telegram chat ${chatId}`,
  };
}
