import { z } from "zod";

/**
 * Discord: post a message through a channel webhook (Channel settings > Integrations > Webhooks).
 * The webhook URL is the credential, so keep it in a workspace secret: `{{ secrets.DISCORD_WEBHOOK }}`.
 */
export const DISCORD_HOSTS = ["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"];
export const DISCORD_MAX_CONTENT = 2_000;

export const discordConfig = z.object({
  webhookUrl: z.string().trim().min(1, "Paste the webhook URL or a secret").max(500),
  content: z.string().min(1, "Write the message").max(4_000),
  /** Shown instead of the webhook's own name. */
  username: z.string().max(80).default(""),
});

export type DiscordConfig = z.infer<typeof discordConfig>;
