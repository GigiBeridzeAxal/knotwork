import { z } from "zod";

/**
 * Telegram: send a message as a bot (made with @BotFather). The bot token is the credential, so keep
 * it in a workspace secret: `{{ secrets.TELEGRAM_BOT_TOKEN }}`.
 */
export const TELEGRAM_HOST = "api.telegram.org";
export const TELEGRAM_MAX_TEXT = 4_096;
export const telegramParseModes = ["", "HTML", "MarkdownV2"] as const;

export const telegramConfig = z.object({
  botToken: z.string().trim().min(1, "Paste the bot token or a secret").max(500),
  /** A numeric chat id, or @channelname for a public channel. */
  chatId: z.string().trim().min(1, "Enter the chat id").max(200),
  text: z.string().min(1, "Write the message").max(8_000),
  parseMode: z.enum(telegramParseModes).default(""),
  silent: z.boolean().default(false),
});

export type TelegramConfig = z.infer<typeof telegramConfig>;
