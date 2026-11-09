import type { Step, StepType, WorkflowInput } from "./schema";

export const STEP_TYPES: { type: StepType; label: string; blurb: string }[] = [
  { type: "http", label: "HTTP request", blurb: "Call any API or webhook" },
  { type: "transform", label: "Transform", blurb: "Reshape data with templates" },
  { type: "filter", label: "Filter", blurb: "Stop the run unless a condition holds" },
  { type: "delay", label: "Delay", blurb: "Wait, then carry on" },
  { type: "log", label: "Log", blurb: "Write a line to the run log" },
  { type: "if", label: "If / else", blurb: "Run one set of steps or another" },
  { type: "loop", label: "Loop", blurb: "Run steps once per item of a list" },
  { type: "slack", label: "Slack", blurb: "Post a message to a channel" },
  { type: "discord", label: "Discord", blurb: "Post a message to a channel" },
  { type: "telegram", label: "Telegram", blurb: "Send a message as your bot" },
  { type: "github", label: "GitHub", blurb: "Open an issue, comment, read a repo" },
];

/** Ready-made steps: forms for one service each, instead of a raw HTTP request. */
export const CONNECTOR_TYPES = ["slack", "discord", "telegram", "github"] as const satisfies readonly StepType[];

export function newStep(type: StepType, taken: string[]): Step {
  let n = 1;
  while (taken.includes(`${type}_${n}`)) n++;
  const id = `${type}_${n}`;
  const retry = { max: 0, backoffSeconds: 5 };
  switch (type) {
    case "http":
      return {
        id,
        name: "HTTP request",
        type,
        retry: { max: 2, backoffSeconds: 5 },
        config: { method: "GET", url: "https://", headers: {}, failOnError: true },
      };
    case "transform":
      return { id, name: "Transform", type, retry, config: { output: { value: "{{ trigger.body }}" } } };
    case "filter":
      return { id, name: "Filter", type, retry, config: { left: "{{ trigger.body.status }}", op: "equals", right: "paid" } };
    case "delay":
      return { id, name: "Delay", type, retry, config: { seconds: 60 } };
    case "log":
      return { id, name: "Log", type, retry, config: { message: "Run {{ run.id }} reached this step" } };
    case "if":
      return { id, name: "If", type, retry, config: { left: "{{ trigger.body.amount }}", op: "gt", right: "100" }, then: [], else: [] };
    case "loop":
      return { id, name: "Loop", type, retry, config: { items: "{{ trigger.body.items }}" }, steps: [] };
    case "slack":
      return { id, name: "Post to Slack", type, retry: { max: 2, backoffSeconds: 5 }, config: { webhookUrl: "{{ secrets.SLACK_WEBHOOK }}", text: "Run {{ run.id }} of {{ workflow.name }} says hello", mentions: false } };
    case "discord":
      return { id, name: "Post to Discord", type, retry: { max: 2, backoffSeconds: 5 }, config: { webhookUrl: "{{ secrets.DISCORD_WEBHOOK }}", content: "Run {{ run.id }} of {{ workflow.name }} says hello", username: "" } };
    case "telegram":
      return {
        id,
        name: "Send on Telegram",
        type,
        retry: { max: 2, backoffSeconds: 5 },
        config: { botToken: "{{ secrets.TELEGRAM_BOT_TOKEN }}", chatId: "@your_channel", text: "Run {{ run.id }} of {{ workflow.name }} says hello", parseMode: "", silent: false },
      };
    case "github":
      return {
        id,
        name: "Open a GitHub issue",
        type,
        retry: { max: 2, backoffSeconds: 5 },
        config: { action: "create_issue", token: "{{ secrets.GITHUB_TOKEN }}", repo: "owner/name", title: "Knotwork run {{ run.id }}", body: "", number: "", labels: "" },
      };
  }
}

export const BLANK: WorkflowInput = {
  name: "Untitled workflow",
  description: "",
  enabled: true,
  trigger: { type: "manual" },
  steps: [],
};

export const EXAMPLES: { title: string; blurb: string; workflow: WorkflowInput }[] = [
  {
    title: "Watch a GitHub repo",
    blurb: "Every hour, read a repo's stars and forks and log them.",
    workflow: {
      name: "Watch a GitHub repo",
      description: "Hourly snapshot of a repository's stars, forks and open issues.",
      enabled: true,
      trigger: { type: "schedule", cron: "0 * * * *" },
      steps: [
        {
          id: "repo",
          name: "Fetch the repo",
          type: "http",
          retry: { max: 3, backoffSeconds: 10 },
          config: {
            method: "GET",
            url: "https://api.github.com/repos/GigiBeridzeAxal/knotwork",
            headers: { accept: "application/vnd.github+json" },
            failOnError: true,
          },
        },
        {
          id: "stats",
          name: "Pick the numbers",
          type: "transform",
          retry: { max: 0, backoffSeconds: 5 },
          config: {
            output: {
              stars: "{{ steps.repo.body.stargazers_count }}",
              forks: "{{ steps.repo.body.forks_count }}",
              issues: "{{ steps.repo.body.open_issues_count }}",
            },
          },
        },
        {
          id: "report",
          name: "Log it",
          type: "log",
          retry: { max: 0, backoffSeconds: 5 },
          config: { message: "{{ steps.stats.stars }} stars, {{ steps.stats.forks }} forks, {{ steps.stats.issues }} open issues" },
        },
      ],
    },
  },
  {
    title: "Big orders only",
    blurb: "A webhook receives orders; only ones over 100 go through.",
    workflow: {
      name: "Big orders only",
      description: "POST an order as JSON to the webhook URL. Orders of 100 or more are passed on.",
      enabled: true,
      trigger: { type: "webhook" },
      steps: [
        {
          id: "big",
          name: "Is it 100 or more?",
          type: "filter",
          retry: { max: 0, backoffSeconds: 5 },
          config: { left: "{{ trigger.body.amount }}", op: "gt", right: "99.99" },
        },
        {
          id: "order",
          name: "Shape the order",
          type: "transform",
          retry: { max: 0, backoffSeconds: 5 },
          config: {
            output: {
              id: "{{ trigger.body.id }}",
              text: "New order {{ trigger.body.id }} for {{ trigger.body.amount }}",
            },
          },
        },
        {
          id: "announce",
          name: "Announce it",
          type: "log",
          retry: { max: 0, backoffSeconds: 5 },
          config: { message: "{{ steps.order.text }}" },
        },
      ],
    },
  },
  {
    title: "Retry and recover",
    blurb: "Calls an API that fails about half the time, so you can watch the retries and the recovery.",
    workflow: {
      name: "Retry and recover",
      description: "This API answers 503 about half the time. Knotwork retries with backoff until it answers 200.",
      enabled: true,
      trigger: { type: "manual" },
      steps: [
        {
          id: "flaky",
          name: "Call a flaky API",
          type: "http",
          retry: { max: 4, backoffSeconds: 5 },
          config: { method: "GET", url: "https://httpbin.org/status/200,503", headers: {}, failOnError: true },
        },
      ],
    },
  },
];
