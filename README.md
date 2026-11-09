<p align="center">
  <img src="public/favicon.svg" width="72" height="72" alt="">
</p>

<h1 align="center">knotwork</h1>
<p align="center"><strong>Workflows that hold.</strong><br>An open-source automation engine that runs on free plans: Cloudflare Workers and MongoDB Atlas M0.</p>

---

Knotwork wires a **trigger** (a webhook, a schedule, or a button) to a list of **steps** (HTTP calls,
transforms, filters, delays, log lines, and `if` and `loop` blocks that hold steps of their own). When a step fails it waits and tries again with backoff, and every
attempt is written to a run log you can open in the dashboard.

**Try it:** [open the live demo](https://knotwork.gigiberidze.com/demo) (one click, no account) ·
[user guide](https://knotwork.gigiberidze.com/docs) · [case study](https://gigiberidze.com/work/knotwork)

![The workflow editor](docs/editor.png)

## What it does

- **Three triggers.** A private webhook URL per workflow, a cron schedule (UTC), or a manual run with test input.
  A webhook can also **check the sender's signature** (GitHub or Stripe) and refuse calls that don't carry one.
- **Seven step types.** `http` calls any API, `transform` reshapes data, `filter` stops a run unless a
  condition holds, `delay` parks the run and picks it up later, and `log` writes a line. Two are blocks:
  `if` runs one list of steps when a condition holds and another when it doesn't, and `loop` runs its steps
  once per item of a list, with `{{ loop.item }}`, `{{ loop.index }}` (counted from 0) and `{{ loop.count }}`.
  Blocks can sit inside blocks.
- **Secrets.** Each workspace keeps API keys and tokens under Settings. Steps use them as
  `{{ secrets.SLACK_URL }}`, so the value is never part of the workflow. Values are stored encrypted, are
  never shown again after saving, and are replaced by `[secret SLACK_URL]` wherever they would appear in a run's log.
- **Run again.** A finished run can be started again with the same input, on the workflow as it is now. It
  counts as a manual run, and isn't possible once the run's input was removed to free space.
- **Templates between steps.** Any string can use `{{ trigger.body.id }}` or `{{ steps.fetch.body.items.0.name }}`.
  A string that is only one template keeps the value's type, so arrays and numbers pass through intact.
  Templates are plain lookups: nothing is evaluated, so a workflow can't run arbitrary code.
- **A canvas editor.** The workflow is drawn as a flow you can pan and zoom: the trigger on top, each step a
  node under it, and a **+** in every gap to add a step there. Click a node to edit it in the side panel (a
  sheet on a phone), drag it to another **+** to move it, or use Move up and Move down. The canvas has no
  layout of its own to save: it is drawn from the same steps as the list view, and a switch flips between the two.
- **Test one step.** A step's Test tab runs just that step against test data you can edit, or load from the
  last run, and shows what it returned. Nothing is saved and no run is started. A step that passes adds its
  output to the test data, so you can test your way down the workflow. Testing an `if` says which way it
  would go and testing a `loop` what it would go through (its first item becomes `loop.item` for testing
  the steps inside); the steps a block holds don't run. A step that uses a secret really sends it, and the
  answer hides it the way a run's log does.
- **Version history.** Every save keeps a copy (the newest 20). Pick one to see it on the canvas, read-only,
  and restore it into the editor if you want it back; it only replaces the current version when you save.
- **Templates, import and export.** Nine ready-made workflows open on the canvas unsaved, so you can look one
  over before pressing Create. Any workflow exports as a small JSON file (trigger and steps only: no webhook
  URL, no history) and imports through the same checks as a save. The file holds whatever was typed into
  the steps, API keys in headers included, so check it before sharing.
- **Durable runs.** A run saves its place in the database as it goes: before and after every step that
  reaches outside, and every few steps in between. Retries use exponential backoff
  (`5s → 20s → 80s`), delays can last up to a week, and a run that was cut off is picked up again by the
  next minute tick.
- **Run history.** Every attempt, a preview of its output, and how long it took. History is kept for 7 days
  after a run starts, or after it wakes from its last wait, so a long delay can't outlive its own run.
- **Accounts and workspaces.** Sign up with a name, email and password (no email to confirm), or open the
  shared **demo account** with one click. Every account starts with a **Personal** workspace and can add more;
  the sidebar switches between them, and its **+** adds a workflow to the one you're in. A workspace only ever
  sees its own workflows and runs, and a link to a workflow or run in another of your workspaces switches there.
  Settings can change your password (which logs out your other devices and revokes your API keys) or delete the account with everything in it.
- **Teams.** The owner of a workspace can share it with an invite link, as an **editor** (changes workflows
  and starts runs) or a **viewer** (only looks). The owner can change a member's role or remove them at any
  time, and a member can leave.
- **Recovery codes.** Knotwork sends no email, so there is no reset link. Instead, Settings makes 8
  one-time recovery codes; one of them, with your email, sets a new password.
- **API keys.** Scripts can list and change workflows, start runs and read results with a key made in
  Settings, read-only or read and write, for one workspace. See the [API reference](docs/api.md).
- **Safe concurrent edits.** Every save carries the version it was loaded at. If someone saved in between
  (another tab, another device), you're asked to keep your version or load theirs, so nothing is lost silently.

![A run](docs/run.png)

## How it works

```
Browser ──► Cloudflare Worker ──► hub (one Durable Object) ──► MongoDB Atlas (free M0 cluster)
              │  /api/auth/*  sign up, log in, demo, log out, password, recovery codes, delete account (session cookie)
              │  /api/*       Hono JSON API for the dashboard, and for scripts with an API key
              │  /hooks/*     public webhook endpoints
              │  /*           React dashboard (static assets, served without the hub), incl. /docs and /demo
              └─ cron: every minute → fire schedules, resume parked runs;
                       every 10 min check storage, hourly check indexes, daily reset the demo
```

The Worker checks the per-IP rate limit and a webhook key's signature, and passes `/api/*`, `/hooks/*` and
the cron tick to the hub, which runs them on a database connection it keeps open.

| Part | Where |
| --- | --- |
| Engine: claims a run, runs steps, retries, parks; the cron tick | [`worker/engine.ts`](worker/engine.ts) |
| Flattens `if` and `loop` blocks into one list with jumps | [`worker/program.ts`](worker/program.ts) |
| Step types, private-address and demo host checks | [`worker/steps.ts`](worker/steps.ts) |
| Secrets: encryption, and hiding values in what runs store | [`worker/secrets.ts`](worker/secrets.ts) |
| Webhook signature checks (GitHub, Stripe) | [`worker/signature.ts`](worker/signature.ts) |
| Testing one step from the editor | [`worker/stepTest.ts`](worker/stepTest.ts) |
| API and webhooks | [`worker/index.ts`](worker/index.ts) |
| Accounts: password hashing, sessions, recovery codes, rate-limit counters | [`worker/auth.ts`](worker/auth.ts) |
| Teams and API keys: roles, invite links, members | [`worker/access.ts`](worker/access.ts) |
| Signed webhook keys and API keys | [`worker/hookKey.ts`](worker/hookKey.ts) |
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

**Blocks.** A workflow's steps are a tree, but a run saves its place as one number. Before a run moves,
its steps are flattened into a list of operations with jumps ([`worker/program.ts`](worker/program.ts)): an
`if` becomes a test that goes on or jumps to its else part, a `loop` becomes a start, its steps, and a
"next item" that jumps back. The place is an index into that list. A workflow without blocks flattens to
its own steps, so nothing changes for it. While a loop runs, its output holds the list and the position
(`{{ steps.<loop id>.item }}` reaches an outer loop's item from inside an inner one); when it ends, only
`{ count }` is left. An `if` step's output is `{ result, branch }`, so later steps can ask
`{{ steps.<if id>.result }}`. Each pass of a loop starts clean: the steps inside write their output again,
a step the pass skips (the other side of an `if`) has none, and the run's 64 KB counts what is stored now.
To collect something from every item, send it somewhere inside the loop. A `filter` inside a block still
stops the whole run; to skip one item, use an `if`. A loop takes at most 50 items (a longer list fails the
step, nothing is cut silently), and a run takes at most 200 steps, where every time a step runs counts:
each pass of a loop, each retry, each `if` check and each start of a loop (so 50 items with 3 steps inside
is 151). A loop inside a loop can't run away.

**Saving as it goes.** A step that reaches outside (an `http` call, a `delay`) starts from a saved place and
is saved right after, so a Worker that stops can't make it happen twice. Steps that only compute (`if`,
`transform`, `filter`, `log`, a loop moving on) are saved together, every 25 log lines or every second,
whichever comes first; if the Worker
stops in between they run again and give the same result. A 50-item loop of such steps costs a handful of
database writes, not 150. A run makes at most 30 requests to other sites in one go, and the runs woken in
the same minute at most 40 together, because Cloudflare's free plan allows 50 outgoing requests per
invocation; every redirect followed counts as a request. A run that reaches either number says so and
carries on at the next minute's turn (later when many runs are making requests at once), so a loop of 50
requests takes a minute or two longer.

**Secrets.** A secret's value is encrypted with AES-256-GCM before it is stored. The key is derived
(HKDF-SHA-256) from `AUTH_PEPPER`, which only the Worker has, with the workspace id as salt, so a copy of the
database alone can't be read and each workspace has its own key; the workspace id and the secret's name are
bound into the ciphertext, so a stored value can't be moved to another name or workspace. The API lists
names and dates and never sends a value back. A run reads and decrypts only the secrets its steps name. Every
output, log line and error a run stores goes through one function that replaces each secret's value (as it
is, as it looks inside JSON text, URL-encoded, and, for a secret that is a web address, without its scheme,
as its path alone, or as one of its query values of 8 characters or more) with `[secret NAME]`, also in what later steps see. What a step says about itself in
the log (the address it called, the two sides of a condition) is written with the secret already swapped
for its mark, so cutting or parsing the text can't leave part of one: a Slack webhook URL kept as a secret
logs as `POST [secret SLACK_URL] → 200`. A value changed some other way (hashed, base64) can't be
recognised, so don't send a secret to a service that transforms and echoes it. Two things are not hidden:
the trigger's own input (a webhook body or header is stored as it arrived, so have callers sign their calls
instead of sending a shared token in a header), and whatever a step sends out, which is the point of a
secret. When a service redirects to another site, headers and bodies filled in from a secret are not sent
on. A step that names a secret that isn't set fails saying which one, instead of sending an empty value.
Values are trimmed when saved. The shared demo account can't keep secrets.

**Signed webhooks.** With the check on, the Worker computes HMAC-SHA-256 over the request's bytes exactly as
they arrived, with the signing secret kept as a workspace secret, and compares in constant time: GitHub's
`X-Hub-Signature-256`, or Stripe's `Stripe-Signature` (whose signed time must be within 5 minutes, so a
captured call can't be replayed later; GitHub's signature carries no time, so change the secret if a signed
call may have been captured). A call that fails answers 401, starts no run and uses none of the account's
run budget. Nothing shows in Knotwork for a refused call: look at the webhook's Recent Deliveries on GitHub,
or the event's delivery attempts in Stripe, where the answer says why.

Setting one up:

1. Save the signing secret under Settings, then Secrets (for example `GH_SIGNING`), and pick it in the
   workflow's trigger next to "Check the sender's signature".
2. **GitHub:** in the repository, Settings, then Webhooks, then Add webhook. Payload URL: the workflow's
   webhook URL. Content type: `application/json` (the default, form encoding, also works: Knotwork unwraps
   its `payload` field). Secret: the same value. GitHub sends a `ping` event when the webhook is created,
   which starts a run; an `if` on `{{ trigger.headers.x-github-event }}` can skip it.
3. **Stripe:** Developers, then Webhooks, add an endpoint with the workflow's webhook URL, and save its
   signing secret (`whsec_…`, the whole text).

**Data.** Collections `users`, `sessions`, `workspaces`, `workflows`, `runs`, `secrets`, `versions` (each
workflow's saved versions), `counters` (rate limits), `members`, `invites` and `apiKeys`.
TTL indexes delete runs after 7 days, sessions after 30 (1 for the demo) and invite links when they expire,
so nothing has to scan for old data. Every 10 minutes (every minute once past 250 MB) the cron checks how much of the cluster's 512 MB is in
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
cut) and how long it took. Nothing is stored. A step that isn't a block goes through the same code as in a
run (a block answers with its condition or its list, without running what it holds), so the
private-address check on every redirect hop, the demo's host list, the 15 s timeout and the 256 KB
response cap all apply; a step that throws is a failed test, not an error. `GET /api/workflows/:id/sample`
hands back the trigger data and outputs of the workflow's newest finished run (or `null`), cut to 32 KB by
leaving out the largest outputs first.

**One connection, kept open.** A Worker can't reuse a socket across requests, and opening a connection to
Atlas (DNS, TLS, SCRAM) measured 30 to 90 ms of CPU in production, several times the free plan's 10 ms. So
the Worker hands `/api/` and `/hooks/` requests and the cron tick to one Durable Object, the hub
([`worker/hub.ts`](worker/hub.ts)), placed in western Europe next to the cluster. The hub keeps its
connection open between requests (two pooled sockets, monitors polling instead of streaming), so only its
first request after it starts pays the handshake. When the database can't be reached, the request answers
503 with a `retry-after` header, and a network error on a connection that has worked before is left to the
driver, which reconnects on its own. The hub starts a new connection only when the old client is finished
(it was closed, or it never connected): at most one every 30 seconds, or after 5 seconds for one that never
got through. As a last resort, a connection that has had nothing but connection errors for three minutes
is replaced too. The hub closes the old one once the work still using it has finished, after two minutes
at the latest. Other errors leave the connection alone. A query that hangs fails after 20 seconds, and one that
waits more than 10 seconds for a free socket fails too. Without the `HUB` binding (the tests) or with
`HUB_OFF` set, each request opens and closes its own connection. Every API response carries a `Server-Timing` header with the total
time, and the connect time when the request had to open the connection.

Measured in production over an hour (2026-11-09): the Worker's CPU was at most 2 ms for a request and 6 ms
for the cron tick, against the 10 ms limit. The hub's tick used about 160 ms of a Durable Object's 30
seconds. The cron wakes the hub every minute, so it stays in memory all day: 128 MB for 86,400 seconds is
about 11,060 GB-s of the free plan's 13,000 GB-s of Durable Object duration a day. There is only one hub,
so that is also the most it can use. Workers & Pages > Durable Objects in the dashboard shows the usage.

**Accounts.** Passwords are hashed with PBKDF2-SHA-256 over an HMAC of the password keyed with `AUTH_PEPPER`,
a secret that is never stored in the database. The iteration count is low, 10,000: it was sized for the
free plan's 10 ms of CPU in a Worker, and still has to fit there when the hub is switched off (`HUB_OFF`). The
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
megabytes. Log lines and errors are cut to 1 KB (UTF-8 bytes), and a run keeps its last 100 log lines. HTTP steps can't call `localhost` or private IP addresses (including IPv4 hidden in IPv6 forms),
every redirect is checked too, and a redirect to another origin drops credential headers. The shared demo
account's HTTP steps can only call a few public test APIs (`DEMO_HOSTS` in `worker/steps.ts`).

**Before MongoDB.** Until accounts were added, Knotwork kept its data in Cloudflare D1, with workflows tied to
a browser rather than an account. That database is left as it was and no longer used: its workflows had no
owner to move them to.

Everything fits free plans: Cloudflare Workers, static assets, cron triggers, the rate limiter and one
Durable Object, and a MongoDB Atlas M0 cluster. It doesn't call any paid AI API.

### Teams, recovery codes and API keys

**Roles.** A workspace has one owner, for good. Others join with an invite link as an editor or a viewer.
The owner does everything; only the owner renames or deletes the workspace, makes and revokes invite
links, and changes or removes members. Editors change workflows and start runs. Viewers read workflows
and runs and change nothing. A personal workspace can't be shared.

**Checked on every request.** A session lists only the workspaces its user owns. Membership and role are
read from `members` on every request (one lookup by id), so a removal or a role change applies on the
member's very next request. Runs, run limits and storage are always charged to the workspace's owner,
whoever started the run.

**Secrets stored as hashes.** An invite link's token and an API key are shown once, when they are made.
The database keeps only their SHA-256, so a copy of it holds no working links or keys. An invite link
works for 7 days and for 10 people, and the owner can revoke it sooner. Removing someone, or making
them a viewer, ends the link they joined with (for everyone who still holds it), so they can't walk back in
with it from another account; a link also lets each account in only once. A used-up link stops counting as open and is removed. The token travels in the request body
(`POST /api/invites/preview` and `/accept`), not in an API URL, so it stays out of request logs.

**API keys.** A key works in one workspace, read-only or read and write, and never has more rights than
its maker has right now: the maker's role is read on every request, and their keys are deleted when they
are removed from the workspace. A key reaches only workflows, runs and the overview (`KEY_PATHS` in
[`worker/index.ts`](worker/index.ts)), never accounts, members, invite links or other keys. Like webhook
URLs, a key carries a signature made with `AUTH_PEPPER`, so a made-up key is refused before any database
lookup.

**Recovery codes.** Each code is 12 characters with 60 random bits, stored as an HMAC of the user id and
the code keyed with `AUTH_PEPPER`, so the database alone can't be used to test guesses. A code works once:
the update that sets the new password also ends the whole set, since someone else may hold a copy of the
sheet. Using one signs out every device and revokes the account's API keys; the owner then makes new codes. Changing the password in Settings
does the same and also ends the remaining codes, so a code someone copied earlier can't undo the change. Making
new codes ends the old ones, and needs the password. Wrong codes count toward their own limit of 10 per
email and IP per 15 minutes.

**Webhook URLs.** A webhook URL starts runs for whoever has it, so viewers and read-only keys get workflows
with an empty `hookKey`. Editors do see them, so after removing an editor the owner can press **New URL**
on a workflow's trigger (`POST /api/workflows/:id/hook-key`) to end the old URL.

**No framing.** [`public/_headers`](public/_headers) tells browsers never to show the app inside another
site's frame, so its delete and revoke buttons can't be clicked through a disguised page.

**The demo account** is shared by everyone, so it can't make invite links, join a workspace, or make API
keys or recovery codes.

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
npm test                                              # unit tests: templates, cron, filters, auth helpers,
                                                      # and teams, recovery codes and API keys (in memory)
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test   # also the engine and data tests, in a throwaway
                                                      # database that is dropped afterwards
npm run build                                         # type-check and build
```

## Tests that run by themselves

Every pull request and every push to `main` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml) on GitHub Actions:

- **Build and tests**: the type-check, the build, and all tests against a throwaway MongoDB.
- **Browser scenarios**: several test accounts, each in its own browser (Chromium, Firefox and WebKit, one of
  them as an iPhone), play multi-user stories against a local Knotwork: two accounts that must not see each
  other's data, two people saving the same workflow, sign-up and the demo, limits, the phone layout, secrets,
  the canvas, templates, version history, blocks built in the editor, and a signed webhook with a run started
  again. The
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

1. Create a free **M0** cluster on [MongoDB Atlas](https://cloud.mongodb.com), in or near western Europe
   (the hub is placed there; for a cluster elsewhere, change `locationHint: "weur"` in
   [`worker/index.ts`](worker/index.ts) to the nearest
   [location hint](https://developers.cloudflare.com/durable-objects/reference/data-location/)), and a database user with only
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
password, webhook URL, API key, recovery code and stored secret stop working. After a change, each secret
still shows under Settings but can't be read; steps that use one say so, and its value has to be entered
again (Replace).

A later deploy that adds collections or indexes needs no `db:setup`: the cron creates any missing index
within the hour (at minute 7). Until then the new collections are nearly empty, so nothing is slow.
Running `db:setup` anyway does no harm. The release that added secrets, blocks and signed webhooks needs no
new setting, secret or migration: it reuses `AUTH_PEPPER`, and old workflows and runs in flight carry on as
they were.

3. Add Cloudflare's free WAF rate-limiting rule for the zone (Security → WAF → Rate limiting rules): requests
   for the hostname `knotwork.gigiberidze.com` whose path starts with `/api/`, more than 10 per 10 seconds
   from one IP, block for 10 seconds. Leave `/hooks/` out, for the same shared-address reason (the free plan
   allows one rule, so it can't have a looser one of its own); the Worker refuses made-up webhook URLs
   without touching the database and limits each URL to 60 calls a minute and each IP to 600. A person
   watching a run polls every 3 seconds, well under the rule.
   The Worker's own limiter answers floods with 429 before they reach the hub, but those requests still
   count toward the Worker's 100,000 a day on the free plan; the WAF rule stops them before the Worker runs. What's left is a known limit of the free
   plan: an IP that stays just under the rule (about 86,000 requests a day) uses most of the daily quota, so
   two such IPs can use all of it, as can heavy calls to webhook URLs. If that happens, `/api` and `/hooks`
   fail until 00:00 UTC while the
   dashboard's static files keep loading.

### The hub

- **First deploy.** `npm run deploy` creates the Durable Object class `Hub` (the `v1` migration in
  `wrangler.jsonc`). Nothing else needs setting up; the free plan allows it because the class is SQLite-backed.
- **Rolling back.** Cloudflare refuses `wrangler rollback` to a version from before a Durable Object
  migration, so you can't roll back past the deploy that added the hub. If the hub itself is the problem,
  deploy without it: `npm run build && npx wrangler deploy --var HUB_OFF:1`. Every request then opens its own connection
  (about 2 seconds slower, and over the free plan's CPU limit, which Cloudflare enforces loosely), so use it
  only until the fix is deployed. Rollbacks between versions that both have the hub work as usual.
- **Daily limits on the free plan.** 100,000 requests to the hub (every `/api/` and `/hooks/` call that
  passes the rate limit and, for a webhook, has a real key, plus 1,440 cron ticks) and 13,000 GB-s of duration (the hub uses about 11,060).
  They are separate from the Worker's own 100,000 requests, and they are per Cloudflare account: a second
  always-on Durable Object (a staging copy, say) would take the duration over the limit.
- **At a limit.** Calls to the hub fail until 00:00 UTC. The Worker then answers `/api/` and `/hooks/` with
  503 and a plain message, the dashboard shows "Knotwork isn't answering right now" instead of the login
  page, and schedules and waiting runs pick up again after midnight. Workers & Pages > Durable Objects in
  the dashboard shows both numbers.

The Worker is served at `knotwork.gigiberidze.com` (the `routes` entry in `wrangler.jsonc`). Change that to your
own domain, or remove it to use the `*.workers.dev` address.

Anyone can sign up on a deployment. Webhook URLs are public; the random key in each URL is its secret.

## Limits

Because anyone can sign up, there are limits ([`shared/limits.ts`](shared/limits.ts)) that keep one
person from using up the free plans:

- 5 workspaces per account, 10 workflows per workspace and 25 steps per workflow (counting the steps inside
  blocks, which nest at most 3 levels deep).
- 50 items per loop, and 200 steps per run. Every time a step runs counts: each pass of a loop, each retry,
  each `if` check and each start of a loop. Moving a loop to its next item doesn't.
- 30 requests to other sites per run in one go; a run that makes more carries on usually within a minute, later when many runs make requests at once.
- 20 secrets per workspace, each 8 to 4,000 characters.
- JSON you send (a workflow, a test input, a webhook body) may be nested 50 levels deep; deeper gets a 400,
  and so does a field name containing a null character. Neither counts as a run. A step output like
  that is replaced by a note saying it couldn't be saved.
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
  attempts per email and IP per 15 minutes (recovery codes have their own 10); 30 demo sign-ins per network
  per hour; 20 sessions per account.
- Teams: 10 members per workspace besides its owner; 5 open invite links per workspace, each working for
  7 days and for 10 people; an account can join 20 other people's workspaces.
- 8 recovery codes at a time, each used once; 10 API keys per account.
- Schedules run at most every 5 minutes, in UTC.
- 32 KB per workflow and 64 KB per webhook payload or test input (a webhook also keeps up to 8,000 characters of headers and 2,000 of query); 64 KB of rendered templates per step.
  HTTP calls get 15s and 256 KB of response; up to 5 retries per step; 16 KB of output is kept per step and
  64 KB per run (UTF-8 bytes); the last 100 log lines are kept. The list a loop goes through counts as its
  output, so it can be at most 16 KB.
- Runs are deleted 7 days after they start, or after they wake from their last wait. Workflows stay until you delete them.
- Version history: the newest 20 versions per workflow, and at most 128 KB of them (the newest is always
  kept).
- 60 single-step tests per account per hour (per network for the shared demo account); test answers and
  sample data are at most 32 KB.
- The demo account is shared by everyone who opens it, so its 60 runs an hour are shared too. Its HTTP steps
  can only call a few public test APIs, and it is reset every day at 03:00 UTC.

## Roadmap

Built: teams with invite links and roles, recovery codes, and API keys (2026-11-09; live from the next deploy).

- An "on failure" step, so a workflow can report that it broke
- Ready-made Slack, Discord, Telegram and GitHub steps
- Teams: invite links with roles, recovery codes, API keys

## License

MIT
