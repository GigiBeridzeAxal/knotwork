<p align="center">
  <img src="public/favicon.svg" width="72" height="72" alt="">
</p>

<h1 align="center">knotwork</h1>
<p align="center"><strong>Workflows that hold.</strong><br>An open-source automation engine that runs on free plans: Cloudflare Workers and MongoDB Atlas M0.</p>

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
- **Accounts and workspaces.** Sign up with a name, email and password (no email to confirm), or open the
  shared **demo account** with one click. Every account starts with a **Personal** workspace and can add more;
  the sidebar switches between them, and its **+** adds a workflow to the one you're in. A workspace only ever
  sees its own workflows and runs.
- **Safe concurrent edits.** Every save carries the version it was loaded at. If someone saved in between
  (another tab, another device), you're asked to keep your version or load theirs, so nothing is lost silently.

![A run](docs/run.png)

## How it works

```
Browser ──► Cloudflare Worker ──► MongoDB Atlas (free M0 cluster)
              │  /api/auth/*  sign up, log in, demo, log out (session cookie)
              │  /api/*       Hono JSON API for the dashboard
              │  /hooks/*     public webhook endpoints
              │  /*           React dashboard (static assets)
              └─ cron: every minute → fire schedules, resume parked runs, reset the demo daily
```

| Part | Where |
| --- | --- |
| Engine: claims a run, runs steps, retries, parks | [`worker/engine.ts`](worker/engine.ts) |
| Step types | [`worker/steps.ts`](worker/steps.ts) |
| API and webhooks | [`worker/index.ts`](worker/index.ts) |
| Accounts: password hashing, sessions, rate limits | [`worker/auth.ts`](worker/auth.ts) |
| Collections, indexes and the per-request connection | [`worker/mongo.ts`](worker/mongo.ts) |
| Demo account | [`worker/demo.ts`](worker/demo.ts) |
| Workflow schema (shared by API and dashboard) | [`shared/schema.ts`](shared/schema.ts) |
| Templates and cron parser | [`shared/template.ts`](shared/template.ts), [`shared/cron.ts`](shared/cron.ts) |
| Dashboard | [`src/`](src) |

A run moves through `queued → running → (waiting →) succeeded | failed | stopped`. Before an invocation
works on a run it **claims** it with an atomic `findOneAndUpdate` and a one-minute lease, so a webhook and the
cron tick can never run the same step twice at the same time. Each step's output, log line and the run's new
position are written in one update to the run's document, and one broken run can't stop the others: it fails
on its own, and a run that keeps getting stuck is given up on after three tries.

**Data.** Collections `users`, `sessions`, `workspaces`, `workflows`, `runs` and `counters` (rate limits).
TTL indexes delete runs after 14 days and sessions after 30, so nothing has to scan for old data.
A Worker can't reuse a socket across requests, so each request opens one connection to Atlas when it first
needs it and closes it when it's done; Smart Placement runs the Worker next to the cluster to keep that short.

**Accounts.** Passwords are hashed with PBKDF2-SHA-256 (100,000 iterations, a random salt each). The session is
a random token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; the database stores only its SHA-256.
Writes from other sites are refused. Sign-ups are limited per IP and per day, and wrong passwords are limited
per email and IP. Steps can't call `localhost` or private IP addresses, and redirects are checked too.

Everything fits free plans: Cloudflare Workers, static assets and cron triggers, and a MongoDB Atlas M0 cluster.
It doesn't call any paid AI API.

## Run it locally

You need a MongoDB to talk to: a free Atlas cluster, or one on your machine
(`docker run -d -p 27017:27017 mongo:8`).

```sh
npm install
echo "MONGODB_URI=mongodb://127.0.0.1:27017" > .dev.vars   # gitignored; use your Atlas string if you like
MONGODB_URI=mongodb://127.0.0.1:27017 npm run db:setup     # creates the indexes, once
npm run dev                                                # http://localhost:5173
```

The cron doesn't fire on its own in local development. Click **Check now** on a waiting run.

```sh
npm test                                              # unit tests: templates, cron, filters, auth helpers
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test   # also the engine and data tests, in a throwaway database
npm run build                                         # type-check and build
```

## Deploy to Cloudflare

1. Create a free **M0** cluster on [MongoDB Atlas](https://cloud.mongodb.com), a database user with
   read and write access, and an IP access list entry `0.0.0.0/0` (Workers have no fixed IP addresses;
   the user's password is what protects the data).
2. Then:

```sh
npx wrangler login
MONGODB_URI="mongodb+srv://..." npm run db:setup   # indexes, once per database
npx wrangler secret put MONGODB_URI                # paste the same connection string
npm run deploy
```

The Worker is served at `knotwork.gigiberidze.com` (the `routes` entry in `wrangler.jsonc`). Change that to your
own domain, or remove it to use the `*.workers.dev` address.

Anyone can sign up on a deployment. Webhook URLs are public; the random key in each URL is its secret.

## Limits

Because anyone can sign up, there are limits ([`shared/limits.ts`](shared/limits.ts)) that keep one
person from using up the free plans:

- 5 workspaces per account, 10 workflows per workspace and 25 steps per workflow.
- 60 runs per account per hour (webhooks, schedules and manual runs together), and 1,500 per hour overall.
- 5 new accounts per IP address per hour and 300 per day; 10 wrong passwords per email and IP per 15 minutes.
- Schedules run at most every 5 minutes, in UTC.
- 15s per HTTP call, 256 KB per webhook payload or response, up to 5 retries per step, 256 KB of step
  outputs per run.
- Runs are deleted after 14 days. Workflows stay until you delete them.
- The demo account is shared by everyone who opens it and is reset every day at 03:00 UTC.

## Roadmap

- Inviting other people into a workspace
- Secrets per workspace, usable in templates (`{{ secrets.SLACK_URL }}`)
- Branching (if / else) and loops over arrays
- A visual canvas editor
- Signed webhooks (GitHub, Stripe) and replaying a past run

## License

MIT
