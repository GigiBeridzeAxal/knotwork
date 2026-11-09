import type { ReactNode } from "react";
import { githubActions, type GithubAction } from "../../shared/connectors/github";
import { telegramParseModes } from "../../shared/connectors/telegram";
import type { Step } from "../../shared/schema";
import { cn, Field, inputClass, textareaClass } from "../components/ui";
import { JsonArea } from "./StepEditor";

/** The forms for the ready-made steps (Slack, Discord, Telegram, GitHub). Every field takes templates. */

type Connector = Extract<Step, { type: "slack" | "discord" | "telegram" | "github" }>;

const GITHUB_LABELS: Record<GithubAction, string> = {
  create_issue: "Open an issue",
  add_comment: "Comment on an issue or pull request",
  get_repo: "Read a repository",
};

const TELEGRAM_LABELS: Record<(typeof telegramParseModes)[number], string> = { "": "Plain text", HTML: "HTML", MarkdownV2: "MarkdownV2" };

const secretHint = (name: string, where: ReactNode) => (
  <>
    {where} Keep it in a workspace secret and write <code className="font-mono">{`{{ secrets.${name} }}`}</code> here, so it never sits in the workflow or the run log.
  </>
);

/** A credential field: hidden while it holds a pasted value, shown while it holds a template. */
function Credential({ id, label, value, placeholder, hint, onChange }: { id: string; label: string; value: string; placeholder: string; hint: ReactNode; onChange: (v: string) => void }) {
  const template = value.includes("{{");
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <input
        id={id}
        type={template || value === "" ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        className={cn(inputClass, "font-mono")}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function Message({ id, label, value, max, rows = 4, hint, onChange }: { id: string; label: string; value: string; max: number; rows?: number; hint?: ReactNode; onChange: (v: string) => void }) {
  return (
    <Field label={label} htmlFor={id} hint={hint ?? `Templates work here. The service takes up to ${max.toLocaleString("en-US")} characters.`}>
      <textarea id={id} rows={rows} spellCheck={false} className={textareaClass} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

export function ConnectorFields({ step, uid, setConfig }: { step: Connector; uid: string; setConfig: (patch: Record<string, unknown>) => void }) {
  switch (step.type) {
    case "slack":
      return (
        <>
          <Credential
            id={`${uid}-webhook`}
            label="Webhook URL"
            value={step.config.webhookUrl}
            placeholder="{{ secrets.SLACK_WEBHOOK }}"
            hint={secretHint("SLACK_WEBHOOK", "From your Slack app's Incoming Webhooks page (https://hooks.slack.com/…).")}
            onChange={(webhookUrl) => setConfig({ webhookUrl })}
          />
          <Message id={`${uid}-text`} label="Message" value={step.config.text} max={40_000} onChange={(text) => setConfig({ text })} />
          <Field label="Blocks (optional)" htmlFor={`${uid}-blocks`} hint="Block Kit JSON for a richer layout. The message above is still shown in notifications.">
            <JsonArea id={`${uid}-blocks`} rows={4} value={step.config.blocks} onChange={(blocks) => setConfig({ blocks })} placeholder='[{ "type": "section", "text": { "type": "mrkdwn", "text": "*Hello*" } }]' />
          </Field>
        </>
      );
    case "discord":
      return (
        <>
          <Credential
            id={`${uid}-webhook`}
            label="Webhook URL"
            value={step.config.webhookUrl}
            placeholder="{{ secrets.DISCORD_WEBHOOK }}"
            hint={secretHint("DISCORD_WEBHOOK", "From the channel's Settings > Integrations > Webhooks (https://discord.com/api/webhooks/…).")}
            onChange={(webhookUrl) => setConfig({ webhookUrl })}
          />
          <Message
            id={`${uid}-content`}
            label="Message"
            value={step.config.content}
            max={2_000}
            hint="Templates work here. Discord takes up to 2,000 characters. @everyone and role pings are switched off."
            onChange={(content) => setConfig({ content })}
          />
          <Field label="Post as (optional)" htmlFor={`${uid}-username`} hint="Leave empty to use the webhook's own name.">
            <input id={`${uid}-username`} className={inputClass} value={step.config.username} onChange={(e) => setConfig({ username: e.target.value })} />
          </Field>
        </>
      );
    case "telegram":
      return (
        <>
          <Credential
            id={`${uid}-token`}
            label="Bot token"
            value={step.config.botToken}
            placeholder="{{ secrets.TELEGRAM_BOT_TOKEN }}"
            hint={secretHint("TELEGRAM_BOT_TOKEN", "@BotFather gives you one when you make a bot.")}
            onChange={(botToken) => setConfig({ botToken })}
          />
          <Field label="Chat id" htmlFor={`${uid}-chat`} hint="A number like -1001234567890, or @channelname for a public channel. Add the bot to the chat first.">
            <input id={`${uid}-chat`} className={cn(inputClass, "font-mono")} value={step.config.chatId} onChange={(e) => setConfig({ chatId: e.target.value })} />
          </Field>
          <Message id={`${uid}-text`} label="Message" value={step.config.text} max={4_096} onChange={(text) => setConfig({ text })} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Formatting" htmlFor={`${uid}-parse`}>
              <select id={`${uid}-parse`} className={inputClass} value={step.config.parseMode} onChange={(e) => setConfig({ parseMode: e.target.value })}>
                {telegramParseModes.map((m) => (
                  <option key={m} value={m}>
                    {TELEGRAM_LABELS[m]}
                  </option>
                ))}
              </select>
            </Field>
            <label className="flex items-center gap-3 self-end pb-3 text-sm text-soft">
              <input type="checkbox" className="size-4 accent-spark" checked={step.config.silent} onChange={(e) => setConfig({ silent: e.target.checked })} />
              Send without a notification sound
            </label>
          </div>
        </>
      );
    case "github": {
      const { action } = step.config;
      return (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Action" htmlFor={`${uid}-action`}>
              <select id={`${uid}-action`} className={inputClass} value={action} onChange={(e) => setConfig({ action: e.target.value })}>
                {githubActions.map((a) => (
                  <option key={a} value={a}>
                    {GITHUB_LABELS[a]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Repository" htmlFor={`${uid}-repo`} hint="owner/name">
              <input id={`${uid}-repo`} className={cn(inputClass, "font-mono")} value={step.config.repo} onChange={(e) => setConfig({ repo: e.target.value })} />
            </Field>
          </div>
          <Credential
            id={`${uid}-token`}
            label={action === "get_repo" ? "Token (optional for public repositories)" : "Token"}
            value={step.config.token}
            placeholder="{{ secrets.GITHUB_TOKEN }}"
            hint={secretHint("GITHUB_TOKEN", "A fine-grained personal access token with Issues: read and write on this repository.")}
            onChange={(token) => setConfig({ token })}
          />
          {action === "create_issue" && (
            <>
              <Field label="Title" htmlFor={`${uid}-title`}>
                <input id={`${uid}-title`} className={cn(inputClass, "font-mono")} value={step.config.title} onChange={(e) => setConfig({ title: e.target.value })} />
              </Field>
              <Message id={`${uid}-body`} label="Body (Markdown)" value={step.config.body} max={65_536} rows={5} onChange={(body) => setConfig({ body })} />
              <Field label="Labels (optional)" htmlFor={`${uid}-labels`} hint="Comma-separated. Labels must already exist in the repository.">
                <input id={`${uid}-labels`} className={cn(inputClass, "font-mono")} value={step.config.labels} placeholder="bug, from-knotwork" onChange={(e) => setConfig({ labels: e.target.value })} />
              </Field>
            </>
          )}
          {action === "add_comment" && (
            <>
              <Field label="Issue or pull request number" htmlFor={`${uid}-number`}>
                <input id={`${uid}-number`} className={cn(inputClass, "max-w-64 font-mono")} value={step.config.number} placeholder="{{ trigger.body.issue.number }}" onChange={(e) => setConfig({ number: e.target.value })} />
              </Field>
              <Message id={`${uid}-body`} label="Comment (Markdown)" value={step.config.body} max={65_536} rows={5} onChange={(body) => setConfig({ body })} />
            </>
          )}
          {action === "get_repo" && <p className="text-[13px] text-muted">Gives later steps fullName, description, stars, forks, openIssues, watchers, defaultBranch and url.</p>}
        </>
      );
    }
  }
}
