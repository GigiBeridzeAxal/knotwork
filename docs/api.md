# Knotwork API

This is the reference for scripts that use Knotwork with an API key: list and change workflows, start
runs and read their results. The dashboard uses the same API with a session cookie; this page covers only
what a key can do.

Base URL: `https://knotwork.gigiberidze.com/api`

Every request and response body is JSON. Times are milliseconds since 1970-01-01 UTC.

## Make a key

1. Sign in and open **Settings > API keys**.
2. Give the key a name (up to 40 characters), pick one workspace, and pick **read** or **write**.
3. Copy the key. It is shown once. Knotwork stores only its SHA-256 hash, so it can't show it again. If
   you lose it, revoke it and make a new one.

What a key can do:

- **One workspace.** A key works in the workspace it was made for, and in no other.
- **Read or write.** A read key can only make `GET` requests. A write key can also create, change and
  delete workflows and start runs.
- **Never more than its maker.** The maker's role in the workspace is read again on every request. A
  viewer can only make read keys. If the maker is made a viewer later, their write keys can only read
  from then on. If the maker is removed from the workspace (or leaves it), their keys for it are deleted.
- Keys are also deleted when the workspace or the maker's account is deleted, and when the maker revokes
  them in Settings. Changing the account's password, or getting back in with a recovery code, revokes
  every key the account made: make new ones afterwards.
- An account can have 10 keys. The shared demo account can't make keys.

The key list in Settings shows each key's first 9 characters and when it was last used (updated at most
once an hour).

## Authentication

Send the key in the `Authorization` header:

```
Authorization: Bearer kw_YOUR_KEY
```

A key is `kw_` followed by 40 letters, digits, `-` and `_`. No workspace header is needed: the key says
which workspace. If you do send `x-knotwork-workspace`, it must name the key's own workspace, or the
request is refused with 403.

A request with an `Authorization` header is judged by that header alone, even if a session cookie comes
with it. A header that isn't exactly `Bearer` and a well-formed key gets 401.

Each key carries a signature, so a made-up key is refused before Knotwork looks anything up.

The API sends no CORS headers, so a web page on another site can't call it with a key. Call it from a
server or a script, and keep the key out of anything a browser downloads.

## Endpoints

A key can call only these. Anything else under `/api` (accounts, passwords, workspaces, members, invite
links, other keys) answers 403.

| Method | Path | Access | What it does |
| --- | --- | --- | --- |
| `GET` | `/workflows` | read | List the workspace's workflows |
| `POST` | `/workflows` | write | Create a workflow |
| `GET` | `/workflows/:id` | read | Get one workflow with its steps |
| `PUT` | `/workflows/:id` | write | Replace a workflow |
| `DELETE` | `/workflows/:id` | write | Delete a workflow and its runs |
| `POST` | `/workflows/:id/run` | write | Start a run |
| `GET` | `/runs` | read | List runs, newest first |
| `GET` | `/runs/:id` | read | Get one run with its log |
| `POST` | `/runs/:id/check` | write | Move a waiting run on now, if it is due |
| `GET` | `/overview` | read | Workflows, recent runs and this hour's run count in one request |

"Access" is what the key needs. For write, the key's maker must also be the workspace's owner or an
editor.

### `GET /workflows`

Returns an array of workflow summaries, most recently changed first. A summary is a workflow (see
[Workflow object](#workflow-object)) whose `steps` hold only each step's `id`, `name` and `type`.

### `POST /workflows`

Body: a [workflow](#workflow-json). Answers `201` with the new workflow object, including its `version`
(1) and, for a write key, its `hookKey`.

Errors: `400` with `issues` when the body doesn't match the schema; `409` when the workspace already has
10 workflows.

### `GET /workflows/:id`

Returns the [workflow object](#workflow-object). `404` if there is no workflow with that id in the key's
workspace.

### `PUT /workflows/:id`

Body: the whole [workflow](#workflow-json) plus the `version` you last read:

```json
{ "version": 3, "name": "...", "trigger": { "type": "manual" }, "steps": [] }
```

Every save adds 1 to `version`. If someone saved since you read it, the answer is `409` and nothing is
changed:

```json
{ "error": "This workflow was changed somewhere else since you opened it.", "current": { "...": "the workflow as it is now" } }
```

Read `current.version`, merge your change into `current`, and send it again. A body without `version`
gets `400`. Answers `200` with the saved workflow.

Saving doesn't change the webhook URL.

### `DELETE /workflows/:id`

Deletes the workflow and all its runs. Answers `204` with no body, or `404`.

### `POST /workflows/:id/run`

Starts a run now, whatever the workflow's trigger is. Body (optional):

```json
{ "input": { "any": "JSON value" } }
```

The input reaches the steps as `trigger.body`, so `{{ trigger.body.any }}` reads it. Answers `202` with
`{ "runId": "run_..." }` as soon as the run is created; the steps run after the answer is sent. Read the
result with `GET /runs/:id`.

Errors: `400` if the body isn't valid JSON; `413` if the body is over 64,000 characters; `429` if the run
can't start because of a [run limit](#rate-limits) (the `error` says which one and when to try again).

### `GET /runs`

Query: `workflowId` (optional) to list one workflow's runs; `limit` (optional, default 50, at most 200).
Returns an array of [run summaries](#run-object), newest first.

### `GET /runs/:id`

Returns the [run](#run-object) with its input and log. `404` if there is no run with that id in the key's
workspace. Runs are deleted 7 days after they start (or after they wake from their last wait).

### `POST /runs/:id/check`

For a run that is `waiting` (in a delay or before a retry): if its time has come, moves it on now
instead of at the next minute's tick. Returns the run as `GET /runs/:id` does.

### `GET /overview`

```json
{ "workflows": [], "runs": [], "runsThisHour": 4, "runsLimit": 60 }
```

`workflows` are summaries as in `GET /workflows`; `runs` are the workspace's newest 100 run summaries.
`runsThisHour` and `runsLimit` are for the workspace's owner, whose account every run is counted against.

## Workflow JSON

This is what `POST` and `PUT` accept (`shared/schema.ts`). Fields with a default may be left out.

| Field | Type | Rules |
| --- | --- | --- |
| `name` | string | 1 to 80 characters |
| `description` | string | up to 500 characters; default `""` |
| `enabled` | boolean | default `true`. A turned-off workflow ignores its webhook and schedule |
| `trigger` | object | see below |
| `steps` | array | up to 25 steps; step ids must be unique |

The whole workflow can be at most 32,000 characters of JSON.

### Triggers

| `trigger` | What starts a run |
| --- | --- |
| `{ "type": "manual" }` | Only the dashboard's run button, or `POST /workflows/:id/run` |
| `{ "type": "webhook" }` | Any request to the workflow's webhook URL, `https://knotwork.gigiberidze.com/hooks/<hookKey>` |
| `{ "type": "schedule", "cron": "*/15 * * * *" }` | A five-field cron expression, in UTC, at most every 5 minutes |

`POST /workflows/:id/run` works for every trigger type.

### Steps

Every step has:

| Field | Type | Rules |
| --- | --- | --- |
| `id` | string | lowercase letters, digits and `_`, starting with a letter, up to 40 characters. Later steps read its output as `{{ steps.<id>... }}` |
| `name` | string | 1 to 80 characters |
| `type` | string | `http`, `transform`, `filter`, `delay` or `log` |
| `config` | object | depends on `type`, below |
| `retry` | object | optional. `max`: extra attempts after a failure, 0 to 5, default 0. `backoffSeconds`: wait before the first retry, 1 to 3,600, default 5; each later retry waits four times longer |

`config` by type:

| `type` | `config` |
| --- | --- |
| `http` | `url` (required, up to 2,000 characters); `method`: `GET`, `POST`, `PUT`, `PATCH` or `DELETE`, default `GET`; `headers`: object of strings, default `{}`; `body`: optional, a string or any JSON value (sent as JSON unless it is a string); `failOnError`: default `true`, treats a 4xx or 5xx answer as a failure (and retries it) |
| `transform` | `output`: any JSON value. Every string in it is a template; the result is the step's output |
| `filter` | `left` (up to 500 characters), `op`, `right` (up to 500 characters, default `""`). `op` is one of `equals`, `not_equals`, `contains`, `gt`, `lt`, `exists`, `not_exists`. If the condition is false, the run stops there with status `stopped` |
| `delay` | `seconds`: whole number, 1 to 604,800 (7 days) |
| `log` | `message`: up to 2,000 characters |

Any string can use templates: `{{ trigger.body.id }}`, `{{ steps.fetch.body.items.0.name }}`. A string
that is only one template keeps the value's type. An `http` step's output is
`{ "status", "ok", "headers": { "content-type" }, "body" }`.

### Workflow object

What the API returns for a workflow:

```json
{
  "id": "wf_...",
  "workspaceId": "ws_...",
  "name": "...",
  "description": "",
  "enabled": true,
  "trigger": { "type": "webhook" },
  "steps": [],
  "hookKey": "...",
  "version": 1,
  "lastRun": { "id": "run_...", "status": "succeeded", "createdAt": 1762700000000 },
  "createdAt": 1762700000000,
  "updatedAt": 1762700000000
}
```

`lastRun` is `null` before the first run. `hookKey` is the secret part of the webhook URL: anyone who has
it can start runs. A read key, or a write key whose maker is a viewer, always gets `"hookKey": ""`.

Anyone who can read a workflow sees all its step settings, including any headers or tokens written into
an `http` step.

### Run object

A run summary (in `GET /runs` and `GET /overview`):

| Field | Meaning |
| --- | --- |
| `id`, `workflowId`, `workflowName` | Which run, of which workflow |
| `status` | `queued`, `running`, `waiting`, then one of `succeeded`, `failed`, `stopped` |
| `triggerType` | `manual`, `webhook` or `schedule` |
| `stepIndex` | Index of the step it is on (0-based) |
| `attempt` | Attempt number of that step |
| `nextRunAt` | When a `waiting` run moves on next, or `null` |
| `error` | Why it failed or stopped, or `null` |
| `createdAt`, `finishedAt` | `finishedAt` is `null` until it finishes |

`GET /runs/:id` adds:

| Field | Meaning |
| --- | --- |
| `input` | What started it. For `POST /workflows/:id/run`: `{ "body": <your input> }`. For a webhook: `{ "method", "query", "headers", "body" }` |
| `logs` | One entry per attempt: `stepId`, `stepName`, `stepType`, `attempt`, `status` (`ok`, `failed`, `retrying`, `stopped`, `waiting`), `message`, `output`, `startedAt`, `durationMs` |
| `stepCount` | How many steps the run has |

A log entry's `output` is the step's output, cut to a preview when it is over 1,000 bytes:
`{ "truncated": true, "preview": "..." }`. The last 50 log entries are kept.

A run is finished when `status` is `succeeded`, `failed` or `stopped`. Poll until then. A `waiting` run
can sit for as long as its delay or retry backoff.

## Errors

Every error is a JSON object with an `error` message:

```json
{ "error": "Check the highlighted fields", "issues": [{ "code": "too_small", "path": ["steps", 0, "name"], "message": "Give it a name" }] }
```

`issues` appears on `400` answers for a body that doesn't match the schema; each issue has a `path` to the
field and a `message`. A `409` from `PUT` has `current` instead.

| Status | When |
| --- | --- |
| `400` | The body isn't valid JSON or doesn't match the schema; `PUT` without `version` |
| `401` | The key is missing its `Bearer` prefix, malformed, made up or revoked, or its maker no longer has access to the workspace |
| `403` | A read key (or a key whose maker is a viewer) tried to change something or start a run; the path isn't one a key can call; `x-knotwork-workspace` names another workspace; or the request came with an `Origin` header from another site |
| `404` | No workflow or run with that id in the key's workspace |
| `409` | `PUT` with an old `version`; or the workspace already has 10 workflows |
| `413` | The body is over 64 KB, or a run's body is over 64,000 characters |
| `429` | Too many requests, or a run limit was reached |
| `500` | Something went wrong on Knotwork's side |

## Rate limits

Requests:

- 60 requests a minute per IP address (an IPv6 address counts per /64), and 600 a minute per network
  (IPv6 /48). Over that: `429`. Wait a minute.
- On top of that, Cloudflare blocks an IP that sends more than 10 requests to `/api/` in 10 seconds, for
  10 seconds. That answer comes from Cloudflare, not Knotwork, so it isn't Knotwork's JSON. Polling a run
  every 3 seconds stays well under it.

Runs, from `shared/limits.ts`. A run is always counted against the workspace's **owner**, whoever's key
started it, so all keys and members of a workspace share the owner's budget:

- 60 runs per account per clock hour (webhooks, schedules and manual runs together); 10 in the account's
  first 24 hours.
- 100 runs per account queued or waiting at once.
- 4 MB per account per hour of what runs store (input, steps, outputs and logs).
- Across everyone, 3,000 webhook and manual runs an hour; past half of that, accounts that have started 20
  this hour wait for the next. Shared byte pools work the same way.

A run that hits a limit gets `429` with an `error` that says which limit and, for hourly ones, the time
(UTC) to try again.

## What a key can't do

- Sign in, change a password, make recovery codes or delete an account.
- See or change workspaces, members or invite links.
- List, make or revoke API keys.
- Reach any workspace but its own.
- See webhook URLs, if it is a read key or its maker is a viewer.

## Examples

Set the key once (use your own; never commit it):

```sh
export KNOTWORK_KEY=kw_YOUR_KEY
```

List workflows:

```sh
curl -s https://knotwork.gigiberidze.com/api/workflows \
  -H "Authorization: Bearer $KNOTWORK_KEY"
```

Create a workflow (needs a write key). It fetches a to-do item, stops unless it is open, and logs its
title:

```sh
curl -s https://knotwork.gigiberidze.com/api/workflows \
  -H "Authorization: Bearer $KNOTWORK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Check a to-do",
    "description": "Fetches a to-do and logs it if it is still open",
    "trigger": { "type": "manual" },
    "steps": [
      {
        "id": "fetch",
        "name": "Fetch the to-do",
        "type": "http",
        "config": { "method": "GET", "url": "https://jsonplaceholder.typicode.com/todos/{{ trigger.body.id }}" },
        "retry": { "max": 2, "backoffSeconds": 5 }
      },
      {
        "id": "open_only",
        "name": "Only open ones",
        "type": "filter",
        "config": { "left": "{{ steps.fetch.body.completed }}", "op": "equals", "right": "false" }
      },
      {
        "id": "say",
        "name": "Log the title",
        "type": "log",
        "config": { "message": "Still open: {{ steps.fetch.body.title }}" }
      }
    ]
  }'
```

The answer is the new workflow; its `id` looks like `wf_...`.

Start a run with input (needs a write key):

```sh
curl -s -X POST https://knotwork.gigiberidze.com/api/workflows/WORKFLOW_ID/run \
  -H "Authorization: Bearer $KNOTWORK_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "input": { "id": 3 } }'
```

```json
{ "runId": "run_..." }
```

Read the run, and poll until it has finished:

```sh
curl -s https://knotwork.gigiberidze.com/api/runs/RUN_ID \
  -H "Authorization: Bearer $KNOTWORK_KEY"
```

```sh
# Poll every 3 seconds until the run has finished (needs jq).
while :; do
  run=$(curl -s https://knotwork.gigiberidze.com/api/runs/RUN_ID -H "Authorization: Bearer $KNOTWORK_KEY")
  status=$(echo "$run" | jq -r .status)
  case "$status" in succeeded|failed|stopped) echo "$run" | jq; break ;; esac
  sleep 3
done
```
