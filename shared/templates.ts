import type { WorkflowInput } from "./schema";

export const TEMPLATE_CATEGORIES = ["Monitoring", "Webhooks", "Data", "Reliability"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export interface Template {
  /** Stable, URL-safe id: /workflows/new?template=<id>. */
  id: string;
  title: string;
  /** One sentence, under 90 characters, saying what it does in plain words. */
  blurb: string;
  category: TemplateCategory;
  /** Sample test input for a manual or webhook run (becomes trigger.body), or null for schedules. */
  sampleInput: unknown;
  workflow: WorkflowInput;
}

const noRetry = { max: 0, backoffSeconds: 5 };
const json = { "content-type": "application/json" };
const github = { accept: "application/vnd.github+json" };

export const TEMPLATES: Template[] = [
  // ---------- Monitoring ----------
  {
    id: "watch-github-repo",
    title: "Watch a GitHub repo",
    blurb: "Every hour, read a repo's stars and forks and log them.",
    category: "Monitoring",
    sampleInput: null,
    workflow: {
      name: "Watch a GitHub repo",
      description: "Logs a repository's stars, forks and open issues every hour. Press Run to try it now.",
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
            headers: github,
            failOnError: true,
          },
        },
        {
          id: "stats",
          name: "Pick the numbers",
          type: "transform",
          retry: noRetry,
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
          retry: noRetry,
          config: { message: "{{ steps.stats.stars }} stars, {{ steps.stats.forks }} forks, {{ steps.stats.issues }} open issues" },
        },
      ],
    },
  },
  {
    id: "new-release-check",
    title: "New release check",
    blurb: "Every morning, log the latest Node.js release in one line.",
    category: "Monitoring",
    sampleInput: null,
    workflow: {
      name: "New release check",
      description:
        "Reads the latest release of nodejs/node every day at 09:00 UTC and logs it in one line. Press Run to try it now.",
      enabled: true,
      trigger: { type: "schedule", cron: "0 9 * * *" },
      steps: [
        {
          id: "release",
          name: "Fetch the latest release",
          type: "http",
          retry: { max: 3, backoffSeconds: 10 },
          config: {
            method: "GET",
            url: "https://api.github.com/repos/nodejs/node/releases/latest",
            headers: github,
            failOnError: true,
          },
        },
        {
          id: "summary",
          name: "Write a summary",
          type: "transform",
          retry: noRetry,
          config: {
            output: {
              tag: "{{ steps.release.body.tag_name }}",
              line: "Node.js {{ steps.release.body.tag_name }} came out on {{ steps.release.body.published_at }}. Notes: {{ steps.release.body.html_url }}",
            },
          },
        },
        {
          id: "report",
          name: "Log it",
          type: "log",
          retry: noRetry,
          config: { message: "{{ steps.summary.line }}" },
        },
      ],
    },
  },
  {
    id: "uptime-check",
    title: "Uptime check",
    blurb: "Every 10 minutes, check that a site answers and log its status.",
    category: "Monitoring",
    sampleInput: null,
    workflow: {
      name: "Uptime check",
      description:
        "Calls example.com every 10 minutes and retries up to 3 times before the run fails. Press Run to try it now.",
      enabled: true,
      trigger: { type: "schedule", cron: "*/10 * * * *" },
      steps: [
        {
          id: "site",
          name: "Call the site",
          type: "http",
          retry: { max: 3, backoffSeconds: 5 },
          config: { method: "GET", url: "https://example.com", headers: {}, failOnError: true },
        },
        {
          id: "report",
          name: "Log the status",
          type: "log",
          retry: noRetry,
          config: { message: "example.com is up and answered {{ steps.site.status }}" },
        },
      ],
    },
  },

  // ---------- Webhooks ----------
  {
    id: "big-orders-only",
    title: "Big orders only",
    blurb: "A webhook receives orders; only ones over 100 go through.",
    category: "Webhooks",
    sampleInput: { id: "o_1042", amount: 149.5 },
    workflow: {
      name: "Big orders only",
      description:
        "POST an order as JSON to the webhook URL. Orders of 100 or more are passed on. Press Run with the sample order to try it.",
      enabled: true,
      trigger: { type: "webhook" },
      steps: [
        {
          id: "big",
          name: "Is it 100 or more?",
          type: "filter",
          retry: noRetry,
          config: { left: "{{ trigger.body.amount }}", op: "gt", right: "99.99" },
        },
        {
          id: "order",
          name: "Shape the order",
          type: "transform",
          retry: noRetry,
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
          retry: noRetry,
          config: { message: "{{ steps.order.text }}" },
        },
      ],
    },
  },
  {
    id: "webhook-relay",
    title: "Webhook relay",
    blurb: "Turn an incoming event into a chat message and post it on.",
    category: "Webhooks",
    sampleInput: { user: "Ana", event: "deployed the website", link: "https://example.com/deploys/42" },
    workflow: {
      name: "Webhook relay",
      description:
        "Turns a JSON event sent to the webhook URL into a chat message and posts it to an echo service. Press Run with the sample event to try it.",
      enabled: true,
      trigger: { type: "webhook" },
      steps: [
        {
          id: "message",
          name: "Write the message",
          type: "transform",
          retry: noRetry,
          config: {
            output: {
              channel: "#updates",
              text: "{{ trigger.body.user }} {{ trigger.body.event }}. {{ trigger.body.link }}",
            },
          },
        },
        {
          id: "send",
          name: "Post the message",
          type: "http",
          retry: { max: 2, backoffSeconds: 5 },
          config: {
            method: "POST",
            url: "https://postman-echo.com/post",
            headers: json,
            body: "{{ steps.message }}",
            failOnError: true,
          },
        },
        {
          id: "report",
          name: "Log what was sent",
          type: "log",
          retry: noRetry,
          config: { message: "Sent to {{ steps.send.body.json.channel }}: {{ steps.send.body.json.text }}" },
        },
      ],
    },
  },

  // ---------- Data ----------
  {
    id: "form-to-crm",
    title: "Form to CRM",
    blurb: "Save form sign-ups that have an email as contacts in another app.",
    category: "Data",
    sampleInput: { name: "Nino", email: "nino@example.com", company: "Tbilisi Tea Co" },
    workflow: {
      name: "Form to CRM",
      description:
        "POST a form entry with a name and email to the webhook URL. Entries without an email stop here. Press Run with the sample entry to try it.",
      enabled: true,
      trigger: { type: "webhook" },
      steps: [
        {
          id: "has_email",
          name: "Check for an email",
          type: "filter",
          retry: noRetry,
          config: { left: "{{ trigger.body.email }}", op: "exists", right: "" },
        },
        {
          id: "contact",
          name: "Shape the contact",
          type: "transform",
          retry: noRetry,
          config: {
            output: {
              name: "{{ trigger.body.name }}",
              email: "{{ trigger.body.email }}",
              company: "{{ trigger.body.company }}",
              source: "Website form",
            },
          },
        },
        {
          id: "save",
          name: "Send it to the CRM",
          type: "http",
          retry: { max: 2, backoffSeconds: 5 },
          config: {
            method: "POST",
            url: "https://httpbin.org/anything/contacts",
            headers: json,
            body: "{{ steps.contact }}",
            failOnError: true,
          },
        },
        {
          id: "report",
          name: "Log the contact",
          type: "log",
          retry: noRetry,
          config: { message: "Saved {{ steps.save.body.json.name }} <{{ steps.save.body.json.email }}>" },
        },
      ],
    },
  },
  {
    id: "daily-digest",
    title: "Daily digest",
    blurb: "Every morning, fetch a to-do list and log the first three items.",
    category: "Data",
    sampleInput: null,
    workflow: {
      name: "Daily digest",
      description:
        "Fetches a to-do list every day at 08:00 UTC and logs the first three titles in one line. Press Run to try it now.",
      enabled: true,
      trigger: { type: "schedule", cron: "0 8 * * *" },
      steps: [
        {
          id: "todos",
          name: "Fetch the to-dos",
          type: "http",
          retry: { max: 2, backoffSeconds: 10 },
          config: {
            method: "GET",
            url: "https://jsonplaceholder.typicode.com/todos?userId=1",
            headers: {},
            failOnError: true,
          },
        },
        {
          id: "digest",
          name: "Pick the first three",
          type: "transform",
          retry: noRetry,
          config: {
            output: {
              first: "{{ steps.todos.body.0.title }}",
              second: "{{ steps.todos.body.1.title }}",
              third: "{{ steps.todos.body.2.title }}",
            },
          },
        },
        {
          id: "report",
          name: "Log the digest",
          type: "log",
          retry: noRetry,
          config: { message: "Today: 1) {{ steps.digest.first }} 2) {{ steps.digest.second }} 3) {{ steps.digest.third }}" },
        },
      ],
    },
  },

  // ---------- Reliability ----------
  {
    id: "retry-and-recover",
    title: "Retry and recover",
    blurb: "Calls an API that fails on purpose, so you can watch the retries.",
    category: "Reliability",
    sampleInput: {},
    workflow: {
      name: "Retry and recover",
      description:
        "The request always gets a 503, so Knotwork retries it twice with backoff and then marks the run failed. Press Run and open the run log to watch.",
      enabled: true,
      trigger: { type: "manual" },
      steps: [
        {
          id: "flaky",
          name: "Call a failing API",
          type: "http",
          retry: { max: 2, backoffSeconds: 5 },
          config: { method: "GET", url: "https://httpbin.org/status/503", headers: {}, failOnError: true },
        },
      ],
    },
  },
  {
    id: "delayed-follow-up",
    title: "Delayed follow-up",
    blurb: "When someone signs up, wait a minute, then send them a follow-up.",
    category: "Reliability",
    sampleInput: { name: "Luka", email: "luka@example.com" },
    workflow: {
      name: "Delayed follow-up",
      description:
        "POST a sign-up with a name and email to the webhook URL. The run waits 60 seconds, then sends a follow-up. Press Run with the sample to try it.",
      enabled: true,
      trigger: { type: "webhook" },
      steps: [
        {
          id: "received",
          name: "Note the sign-up",
          type: "log",
          retry: noRetry,
          config: { message: "{{ trigger.body.name }} signed up. Following up in 1 minute." },
        },
        {
          id: "wait",
          name: "Wait a minute",
          type: "delay",
          retry: noRetry,
          config: { seconds: 60 },
        },
        {
          id: "follow_up",
          name: "Send the follow-up",
          type: "http",
          retry: { max: 3, backoffSeconds: 10 },
          config: {
            method: "POST",
            url: "https://postman-echo.com/post",
            headers: json,
            body: {
              to: "{{ trigger.body.email }}",
              subject: "Thanks for signing up",
              text: "Hi {{ trigger.body.name }}, thanks for signing up. Reply to this email if you have any questions.",
            },
            failOnError: true,
          },
        },
        {
          id: "report",
          name: "Log the result",
          type: "log",
          retry: noRetry,
          config: { message: "Follow-up sent to {{ steps.follow_up.body.json.to }} ({{ steps.follow_up.status }})" },
        },
      ],
    },
  },
];

export const findTemplate = (id: string) => TEMPLATES.find((t) => t.id === id);
