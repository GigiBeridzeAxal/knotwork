import { z } from "zod";

/**
 * Slack: post a message through an incoming webhook (Slack app > Incoming Webhooks). The webhook URL
 * is the credential, so keep it in a workspace secret: `{{ secrets.SLACK_WEBHOOK }}`.
 */
export const SLACK_HOST = "hooks.slack.com";
export const SLACK_MAX_TEXT = 40_000;

export const slackConfig = z.object({
  webhookUrl: z.string().trim().min(1, "Paste the webhook URL or a secret").max(500),
  text: z.string().min(1, "Write the message").max(4_000),
  /** Optional Block Kit blocks, any JSON; templates work inside. */
  blocks: z.unknown().optional(),
});

export type SlackConfig = z.infer<typeof slackConfig>;
