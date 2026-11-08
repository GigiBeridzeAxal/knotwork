<p align="center">
  <img src="public/favicon.svg" width="72" height="72" alt="">
</p>

<h1 align="center">knotwork</h1>
<p align="center"><strong>Workflows that hold.</strong><br>An open-source automation engine that runs on Cloudflare's free plan.</p>

---

Knotwork wires a **trigger** (a webhook, a schedule, or a button) to a list of **steps** (HTTP calls,
transforms, filters, delays, log lines). When a step fails it waits and tries again with backoff, and every
attempt is written to a run log you can open in the dashboard.

![The workflow editor](docs/editor.png)

## What it does

- **Three triggers.** A private webhook URL per workflow, a cron schedule (UTC), or a manual run with test input.
- **Five step types.** `http` calls any API, `transform` reshapes data, `filter` stops a run unless a
  condition holds, `delay` parks the run and picks it up later, and `log` writes a line.
- **Templates between steps.** Any string can use `{{ trigger.body.id }}` or `{{ steps.fetch.body.items.0.name }}`.
  A string that is only one template keeps the value's type, so arrays and numbers pass through intact.
  Templates are plain lookups: nothing is evaluated, so a workflow can't run arbitrary code.
- **Durable runs.** A run saves its place in the database after every step. Retries use exponential backoff
  (`5s → 20s → 80s`), delays can last up to a week, and a run that was cut off is picked up again by the
  next minute tick.
- **Run history.** Every attempt, its output, and how long it took. History is kept for 14 days.
- **No sign-up.** Each visitor gets a private workspace, an id kept in their browser. A workspace only ever
  sees its own workflows and runs, and a link with `?workspace=` opens it on another device.

![A run](docs/run.png)

## How it works

```
Browser ──► Cloudflare Worker ──► D1 (SQLite)
              │  /api/*   Hono JSON API for the dashboard
              │  /hooks/* public webhook endpoints
              │  /*       React dashboard (static assets)
              └─ cron: every minute → fire schedules, resume parked runs, prune old runs
```

| Part | Where |
| --- | --- |
| Engine: claims a run, runs steps, retries, parks | [`worker/engine.ts`](worker/engine.ts) |
| Step types | [`worker/steps.ts`](worker/steps.ts) |
| API and webhooks | [`worker/index.ts`](worker/index.ts) |
| Workflow schema (shared by API and dashboard) | [`shared/schema.ts`](shared/schema.ts) |
| Templates and cron parser | [`shared/template.ts`](shared/template.ts), [`shared/cron.ts`](shared/cron.ts) |
| Database tables | [`migrations/0001_init.sql`](migrations/0001_init.sql) |
| Dashboard | [`src/`](src) |

A run moves through `queued → running → (waiting →) succeeded | failed | stopped`. Before an invocation
works on a run it **claims** it with a conditional `UPDATE` and a one-minute lease, so a webhook and the
cron tick can never run the same step twice at the same time. Each step's log line and the run's new
position are written in one D1 batch.

Everything fits Cloudflare's free plan: Workers, D1, static assets and cron triggers. It doesn't call any
paid AI API.

## Run it locally

```sh
npm install
npm run db:migrate:local   # creates the tables in a local D1 database
npm run dev                # http://localhost:5173
```

The cron doesn't fire on its own in local development. Click **Check now** on a waiting run, or call
`POST /api/tick`.

```sh
npm test         # unit tests: templates, cron, filters, validation
npm run build    # type-check and build
```

## Deploy to Cloudflare

```sh
npx wrangler login
npx wrangler d1 create knotwork          # copy the database_id it prints into wrangler.jsonc
npm run db:migrate                       # create the tables in the real database
npm run deploy
```

The Worker is served at `knotwork.gigiberidze.com` (the `routes` entry in `wrangler.jsonc`). Change that to your
own domain, or remove it to use the `*.workers.dev` address.

Anyone can use a deployment, each in their own workspace. Webhook URLs are public; the random key in
each URL is its secret.

## Limits

Because anyone can use it, each workspace has limits ([`shared/limits.ts`](shared/limits.ts)) that keep one
visitor from using up the free plan:

- 10 workflows per workspace and 25 steps per workflow.
- 60 runs per workspace per hour, across webhooks, schedules and manual runs.
- Schedules run at most every 5 minutes, in UTC.
- 15s per HTTP call, 256 KB per webhook payload or response, up to 5 retries per step.
- Runs are deleted after 14 days, and workflows nobody edits or runs for 30 days are deleted too.

## Roadmap

- Secrets per workspace, usable in templates (`{{ secrets.SLACK_URL }}`)
- Branching (if / else) and loops over arrays
- A visual canvas editor
- Signed webhooks (GitHub, Stripe) and replaying a past run

## License

MIT
