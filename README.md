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
- **A canvas editor.** The workflow is drawn as a flow you can pan and zoom: the trigger on top, each step a
  node under it, and a **+** in every gap to add a step there. Click a node to edit it in the side panel (a
  sheet on a phone), drag it to another **+** to move it, or use Move up and Move down. The canvas has no
  layout of its own to save: it is drawn from the same steps as the list view, and a switch flips between the two.
- **Test one step.** A step's Test tab runs just that step against test data you can edit, or load from the
  last run, and shows what it returned. Nothing is saved and no run is started. A step that passes adds its
  output to the test data, so you can test your way down the workflow.
- **Version history.** Every save keeps a copy (the newest 20). Pick one to see it on the canvas, read-only,
  and restore it into the editor if you want it back; it only replaces the current version when you save.
- **Templates, import and export.** Nine ready-made workflows open on the canvas unsaved, so you can look one
  over before pressing Create. Any workflow exports as a small JSON file (trigger and steps only: no webhook
  URL, no history) and imports through the same checks as a save.
- **Durable runs.** A run saves its place in the database after every step. Retries use exponential backoff
  (`5s → 20s → 80s`), delays can last up to a week, and a run that was cut off is picked up again by the
  next minute tick.
- **Run history.** Every attempt, a preview of its output, and how long it took. History is kept for 7 days
  after a run starts, or after it wakes from its last wait, so a long delay can't outlive its own run.
- **Accounts and workspaces.** Sign up with a name, email and password (no email to confirm), or open the
  shared **demo account** with one click. Every account starts with a **Personal** workspace and can add more;
  the sidebar switches between them, and its **+** adds a workflow to the one you're in. A workspace only ever
  sees its own workflows and runs, and a link to a workflow or run in another of your workspaces switches there.
  Settings can change your password (which logs out your other devices) or delete the account with everything in it.
- **Safe concurrent edits.** Every save carries the version it was loaded at. If someone saved in between
  (another tab, another device), you're asked to keep your version or load theirs, so nothing is lost silently.

![A run](docs/run.png)

## How it works

```
Browser ──► Cloudflare Worker ──► MongoDB Atlas (free M0 cluster)
              │  /api/auth/*  sign up, log in, demo, log out, password, delete account (session cookie)
              │  /api/*       Hono JSON API for the dashboard
              │  /hooks/*     public webhook endpoints
              │  /*           React dashboard (static assets)
              └─ cron: every minute → fire schedules, resume parked runs;
                       every 10 min check storage, hourly check indexes, daily reset the demo
```

| Part | Where |
| --- | --- |
| Engine: claims a run, runs steps, retries, parks; the cron tick | [`worker/engine.ts`](worker/engine.ts) |
| Step types, private-address and demo host checks | [`worker/steps.ts`](worker/steps.ts) |
| Testing one step from the editor | [`worker/stepTest.ts`](worker/stepTest.ts) |
| API and webhooks | [`worker/index.ts`](worker/index.ts) |
| Accounts: password hashing, sessions, rate-limit counters | [`worker/auth.ts`](worker/auth.ts) |
| Queries, and the limits that need the database | [`worker/db.ts`](worker/db.ts) |
| Collections, indexes and the database connection | [`worker/mongo.ts`](worker/mongo.ts) |
| The Durable Object that keeps the connection open | [`worker/hub.ts`](worker/hub.ts) |
| Demo account | [`worker/demo.ts`](worker/demo.ts) |
| Workflow schema (shared by API and dashboard) | [`shared/schema.ts`](shared/schema.ts) |
| Limits | [`shared/limits.ts`](shared/limits.ts) |
| Templates and cron parser | [`shared/template.ts`](shared/template.ts), [`shared/cron.ts`](shared/cron.ts) |
| Step tree helpers (blocks that hold steps), templates | [`shared/tree.ts`](shared/tree.ts), [`shared/templates.ts`](shared/templates.ts) |
| Canvas editor: layout, pan and zoom, side panel | [`src/canvas/`](src/canvas) |
| Dashboard | [`src/`](src) |

A run moves through `queued → running → (waiting →) succeeded | failed | stopped`. Before an invocation
works on a run it **claims** it with an atomic `findOneAndUpdate` and a one-minute lease, so a webhook and the
cron tick can never run the same step twice at the same time. Each step's output, log line and the run's new
position are written in one update to the run's document, and one broken run can't stop the others: it fails
on its own, and a run that keeps getting stuck is given up on after three tries.

Limits that two requests could race past are enforced atomically: run budgets and login attempts are
`$inc` counters with a time window, and a new workspace or workflow is inserted first, then counted, and
taken out again if it went over.

**Data.** Collections `users`, `sessions`, `workspaces`, `workflows`, `runs`, `versions` (each workflow's
saved versions) and `counters` (rate limits).
TTL indexes delete runs after 7 days and sessions after 30 (1 for the demo), so nothing has to scan for old
data. Every 10 minutes (every minute once past 250 MB) the cron checks how much of the cluster's 512 MB is in
use. Past 350 MB, in order and only as far as needed: runs waiting more than a day ahead are stopped, then
the pending runs of accounts holding more than 20 (biggest backlogs first), then each account's finished
runs beyond its newest 50 are deleted (longest histories first, 5 accounts a check, oldest runs first).
Once fewer than 100 such runs are left (or right away near 450 MB), the pending runs of accounts holding 5
or more are stopped, then everyone's oldest finished runs are deleted; near 450 MB, any pending runs. A
stopped run keeps only the reason. Past 450 MB it pauses new runs and sign-ups until there's room again. Runs may also store only so much per hour (90 MB
in all; see Limits), so even a burst can't fill the space between two checks.

**Version history.** Every save of a workflow (and its creation, as version 1) also writes a copy of it to
`versions`, with the version number as part of its id, so a retried save can't add a second copy. Each save
then prunes that workflow's history to its newest 20 versions and to 128 KB in all (dropping the oldest
first, but never the newest). While the database is nearly full no copies are written, and the workflow is
still saved. Deleting a workflow, a workspace or the account deletes its versions, and so does the demo's
daily reset. `GET /api/workflows/:id/versions` lists them newest first (each step's id, name and type
only), and `GET /api/workflows/:id/versions/:version` returns one with everything needed to load it back.

**Testing one step.** `POST /api/steps/test` runs one step once against sample data (`trigger` and earlier
`steps` outputs) and answers with its status (`ok`, `failed`, `stopped`, or `waiting` for a delay, which
doesn't actually wait), message (cut to 1,000 characters), output (at most 32 KB, or a note that it was
cut) and how long it took. Nothing is stored. The step goes through the same code as in a run, so the
private-address check on every redirect hop, the demo's host list, the 15 s timeout and the 256 KB
response cap all apply; a step that throws is a failed test, not an error. `GET /api/workflows/:id/sample`
hands back the trigger data and outputs of the workflow's newest finished run (or `null`), cut to 32 KB by
leaving out the largest outputs first.

**One connection, kept open.** A Worker can't reuse a socket across requests, and opening a connection to
Atlas (DNS, TLS, SCRAM) measured 30 to 90 ms of CPU in production, several times the free plan's 10 ms. So
the Worker hands `/api/` and `/hooks/` requests and the cron tick to one Durable Object, the hub
([`worker/hub.ts`](worker/hub.ts)), placed in western Europe next to the cluster. The hub keeps its
connection open between requests (two pooled sockets, monitors polling instead of streaming), so only its
first request after a quiet spell pays the handshake. Without the `HUB` binding (the tests), each request
opens and closes its own connection. Every API response carries a `Server-Timing` header with the total
time, and the connect time when the request had to open the connection.

Measured in production over an hour (2026-11-09): the Worker's CPU was at most 2 ms for a request and 6 ms
for the cron tick, against the 10 ms limit. The hub's tick used about 160 ms of a Durable Object's 30
seconds. The cron wakes the hub every minute, so it stays in memory all day: 128 MB for 86,400 seconds is
about 11,060 GB-s of the free plan's 13,000 GB-s of Durable Object duration a day. There is only one hub,
so that is also the most it can use. Workers & Pages > Durable Objects in the dashboard shows the usage.

**Accounts.** Passwords are hashed with PBKDF2-SHA-256 over an HMAC of the password keyed with `AUTH_PEPPER`,
a secret that is never stored in the database. The free plan's CPU budget allows only 10,000 iterations; the
pepper is what keeps a copy of the database alone from being used to guess passwords. The session is a random
token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie with the `__Host-` prefix; the database stores only its
SHA-256. Writes from other sites are refused, request bodies are capped at 64 KB, and Cloudflare's rate
limiter turns away more than 60 requests a minute from one IP before any database work. Webhooks are
limited per webhook URL instead (60 a minute), since services like GitHub send everyone's webhooks from a
few shared addresses, plus a looser 600 a minute per IP. Each webhook URL's key carries a signature made
with `AUTH_PEPPER`, so a made-up URL is refused before any database work. Sign-ups and demo
sign-ins are limited per network (IPv6 per /48) and sign-ups per day, login attempts per email and IP, and an
account keeps at most 20 sessions.

**Steps.** Everything one step renders from templates (URL, headers, body, output, message) adds up to at
most 64 KB, so naming a big value many times (`{{ trigger }}` × 1,000) fails the step instead of producing
megabytes. Log lines and errors are cut to 1 KB (UTF-8 bytes), and a run keeps its last 50 log lines. HTTP steps can't call `localhost` or private IP addresses (including IPv4 hidden in IPv6 forms),
every redirect is checked too, and a redirect to another origin drops credential headers. The shared demo
account's HTTP steps can only call a few public test APIs (`DEMO_HOSTS` in `worker/steps.ts`).

**Before MongoDB.** Until accounts were added, Knotwork kept its data in Cloudflare D1, with workflows tied to
a browser rather than an account. That database is left as it was and no longer used: its workflows had no
owner to move them to.

Everything fits free plans: Cloudflare Workers, static assets, cron triggers and the rate limiter, and a
MongoDB Atlas M0 cluster. It doesn't call any paid AI API.

## Run it locally

You need Node.js 22.6 or newer and a MongoDB to talk to: a free Atlas cluster, or one on your machine
(`docker run -d -p 27017:27017 mongo:8`).

```sh
npm install
# .dev.vars is gitignored. Use your Atlas string instead if you like.
printf 'MONGODB_URI=mongodb://127.0.0.1:27017\nAUTH_PEPPER=%s\n' "$(openssl rand -base64 32)" > .dev.vars
MONGODB_URI=mongodb://127.0.0.1:27017 npm run db:setup     # creates the indexes, once
npm run dev                                                # http://localhost:5173
```

`AUTH_PEPPER` must be at least 16 characters, or sign-up and login fail. The database is called `knotwork`
(`MONGODB_DB` in `wrangler.jsonc`; `db:setup` reads the same variable). Webhook URLs carry a signature made
with `AUTH_PEPPER`; a database used by a build from before that (or with another pepper) needs one run of
`db:setup` with `AUTH_PEPPER` set too, which gives those workflows new webhook URLs.

Locally every browser has the same address, so the per-network limits (5 sign-ups an hour, 30 demo sign-ins,
10 login attempts) are shared by everything you test. To start them over, empty the `counters` collection:
`docker exec <container> mongosh knotwork --eval 'db.counters.deleteMany({})'` for the Docker database,
or delete its documents in Atlas's Data Explorer.
The cron doesn't fire on its own in local development: click **Check now** on a waiting run, or run one tick
(schedules and waiting runs) with `curl http://localhost:5173/cdn-cgi/handler/scheduled`.

```sh
npm test                                              # unit tests: templates, cron, filters, auth helpers
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test   # also the engine and data tests, in a throwaway
                                                      # database that is dropped afterwards
npm run build                                         # type-check and build
```

## Tests that run by themselves

Every pull request and every push to `main` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml) on GitHub Actions:

- **Build and tests**: the type-check, the build, and all tests against a throwaway MongoDB.
- **Browser scenarios**: several test accounts, each in its own browser (Chromium, Firefox and WebKit, one of
  them as an iPhone), play multi-user stories against a local Knotwork: two accounts that must not see each
  other's data, two people saving the same workflow, sign-up and the demo, limits, the phone layout. The
  scenarios and their small runner are in [`e2e/`](e2e); the report shows on the run's summary page.

To run the scenarios yourself, start a local MongoDB and `npm run dev` as above, then in a second terminal:

```sh
npx playwright install chromium firefox webkit    # once
npm run e2e
```

`e2e/prep.mjs` makes five test accounts with random passwords (kept in the gitignored `e2e/accounts.env`) and
refuses to run against anything but a MongoDB on your own machine.

[`.github/workflows/live-check.yml`](.github/workflows/live-check.yml) checks the live site every 30 minutes
(`npm run live-check`): the front page, the API, and that the demo account opens with its workflows. If it
fails twice in a row, it opens an issue labelled `live-check`, and closes it when the site works again.

## Deploy to Cloudflare

1. Create a free **M0** cluster on [MongoDB Atlas](https://cloud.mongodb.com) and a database user with only
   the `readWrite` role on the `knotwork` database and a long random password. Add the IP access list entry
   `0.0.0.0/0`: Workers have no fixed IP addresses, so that password is what protects the data.
2. Then:

```sh
npx wrangler login
MONGODB_URI="mongodb+srv://..." npm run db:setup   # indexes, once per database (add DNS_SERVERS=1.1.1.1
                                                   # if it fails with "querySrv ECONNREFUSED")
npx wrangler secret put MONGODB_URI                # paste the same connection string
npx wrangler secret put AUTH_PEPPER                # at least 16 characters; e.g. paste `openssl rand -base64 32`
npm run deploy
```

Keep a copy of `AUTH_PEPPER` outside the repo. It can't be changed later without making every existing
password and webhook URL stop working.

3. Add Cloudflare's free WAF rate-limiting rule for the zone (Security → WAF → Rate limiting rules): requests
   for the hostname `knotwork.gigiberidze.com` whose path starts with `/api/`, more than 10 per 10 seconds
   from one IP, block for 10 seconds. Leave `/hooks/` out, for the same shared-address reason (the free plan
   allows one rule, so it can't have a looser one of its own); the Worker refuses made-up webhook URLs
   without touching the database and limits each URL to 60 calls a minute and each IP to 600. A person
   watching a run polls every 3 seconds, well under the rule.
   The Worker's own limiter answers floods with 429, but those requests still count toward the free plan's
   100,000 a day; the WAF rule stops them before the Worker runs. What's left is a known limit of the free
   plan: an IP that stays just under the rule (about 86,000 requests a day) uses most of the daily quota, so
   two such IPs can use all of it, as can heavy calls to webhook URLs. If that happens, `/api` and `/hooks`
   fail until 00:00 UTC while the
   dashboard's static files keep loading.

The Worker is served at `knotwork.gigiberidze.com` (the `routes` entry in `wrangler.jsonc`). Change that to your
own domain, or remove it to use the `*.workers.dev` address.

Anyone can sign up on a deployment. Webhook URLs are public; the random key in each URL is its secret.

## Limits

Because anyone can sign up, there are limits ([`shared/limits.ts`](shared/limits.ts)) that keep one
person from using up the free plans:

- 5 workspaces per account, 10 workflows per workspace and 25 steps per workflow.
- 60 runs per account per clock hour (webhooks, schedules and manual runs together); 10 in an account's
  first 24 hours. Webhook and manual runs across everyone: 3,000 an hour, and once half of that is used,
  accounts that have already started 20 this hour wait for the next. A schedule that hits its account's
  limit is skipped for that time.
- The cron moves up to 10 runs a minute (scheduled runs, and runs coming back from a delay or retry).
  Accounts take turns, round robin: those it served longest ago go first, 2 runs each, oldest first, and
  spare slots go to busy accounts. Webhook and manual runs start in their own request.
- 100 runs per account queued or waiting (in a delay or retry) at once.
- What runs store (input, steps, outputs and logs, in UTF-8 bytes): 4 MB per account per hour; 60 MB for
  webhook and manual runs together and 30 MB for scheduled runs, each a pool of its own; past half of a
  pool, accounts that had stored more than 200 KB this hour wait for the next. A new run is charged for
  its input and steps; each time it moves, it reserves the most its remaining steps could write and gives
  back what they didn't. A run that can't reserve is paused before its next step (shown as Paused, with the
  reason) and tries again in 10 minutes or at the next hour, whichever is sooner; so the hourly budgets
  never fail a run after a step has done its work. (The 64 KB of outputs per run still can.) Workflows
  with big outputs can reach the 4 MB before the 60 runs an hour (about 60 KB per run on average).
- 60 requests a minute per IP address (IPv6 per /64) and 600 per network (IPv6 per /48); webhooks 60 calls
  a minute per URL, 600 per IP and 3,000 per network; 5 new accounts per network (IPv4 address or IPv6 /48) per hour and
  300 a day; 10 sign-ups with an email that already has an account per network per hour; 10 login
  attempts per email and IP per 15 minutes; 30 demo sign-ins per network per hour; 20 sessions per account.
- Schedules run at most every 5 minutes, in UTC.
- 32 KB per workflow and 64 KB per webhook payload or test input (a webhook also keeps up to 8,000 characters of headers and 2,000 of query); 64 KB of rendered templates per step.
  HTTP calls get 15s and 256 KB of response; up to 5 retries per step; 16 KB of output is kept per step and
  64 KB per run (UTF-8 bytes); the last 50 log lines are kept.
- Runs are deleted 7 days after they start, or after they wake from their last wait. Workflows stay until you delete them.
- Version history: the newest 20 versions per workflow, and at most 128 KB of them (the newest is always
  kept).
- 60 single-step tests per account per hour (per network for the shared demo account); test answers and
  sample data are at most 32 KB.
- The demo account is shared by everyone who opens it, so its 60 runs an hour are shared too. Its HTTP steps
  can only call a few public test APIs, and it is reset every day at 03:00 UTC.

## Roadmap

- Inviting other people into a workspace
- Secrets per workspace, usable in templates (`{{ secrets.SLACK_URL }}`)
- Branching (if / else) and loops over arrays
- A visual canvas editor
- Signed webhooks (GitHub, Stripe) and replaying a past run

## License

MIT
