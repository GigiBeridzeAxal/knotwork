import { type ReactNode, useEffect } from "react";
import { LIMITS } from "../../shared/limits";
import { TEMPLATES } from "../../shared/templates";
import { Logo } from "../components/ui";
import { Link } from "../router";
import { useSession } from "../session";

/**
 * The user guide at /docs. It is public (no sign-in) so the portfolio and the README can link to it.
 * Numbers come from shared/limits.ts, so the page can't drift from what the engine enforces. When a
 * feature lands (secrets, branches, teams...), add its section here and to SECTIONS.
 */

const SECTIONS = [
  { id: "start", label: "Get started" },
  { id: "editor", label: "The editor" },
  { id: "triggers", label: "Triggers" },
  { id: "steps", label: "Steps" },
  { id: "blocks", label: "If / else and loops" },
  { id: "secrets", label: "Secrets" },
  { id: "templates", label: "Templates" },
  { id: "retries", label: "Retries and delays" },
  { id: "runs", label: "Runs" },
  { id: "workspaces", label: "Workspaces and account" },
  { id: "demo", label: "The demo account" },
  { id: "limits", label: "Limits" },
  { id: "help", label: "Problems and answers" },
];

const LIMIT_ROWS: [string, string][] = [
  ["Workspaces per account", `${LIMITS.workspacesPerAccount} (Personal plus ${LIMITS.workspacesPerAccount - 1})`],
  ["Workflows per workspace", String(LIMITS.workflowsPerWorkspace)],
  ["Steps per workflow", `${LIMITS.stepsPerWorkflow}, counting the ones inside blocks`],
  ["Blocks inside blocks", `${LIMITS.stepDepth} levels`],
  ["Items per loop", String(LIMITS.loopItems)],
  ["Steps one run can take", `${LIMITS.stepRunsPerRun} (every step in every loop pass counts, and every retry)`],
  ["Requests to other sites per run", `${LIMITS.httpCallsPerGo} in one go (redirects count), then it carries on, usually within a minute`],
  ["Secrets per workspace", `${LIMITS.secretsPerWorkspace}, each ${LIMITS.secretMinChars} to ${LIMITS.secretMaxChars.toLocaleString("en")} characters`],
  ["Size of a saved workflow", `${LIMITS.workflowBytes / 1000} KB`],
  ["Saved versions per workflow", `the newest ${LIMITS.versionsPerWorkflow}`],
  ["Step tests per hour", String(LIMITS.stepTestsPerHour)],
  ["Webhook body or test input", `${LIMITS.runInputBytes / 1000} KB`],
  ["Runs per hour, per account", `${LIMITS.runsPerAccountPerHour} (${LIMITS.newAccountRunsPerHour} in the first 24 hours)`],
  ["Runs waiting at once, per account", String(LIMITS.pendingRunsPerAccount)],
  ["Webhook calls per URL", "60 a minute"],
  ["Shortest schedule", `every ${LIMITS.minScheduleMinutes} minutes`],
  ["HTTP call", "15 s, 256 KB response, 5 redirects"],
  ["Retries per step", "up to 5"],
  ["Longest delay", "7 days"],
  ["Run history", `${LIMITS.runHistoryDays} days`],
  ["Template output per step", "64 KB"],
  ["Demo sign-ins per network", `${LIMITS.demoLoginsPerIpPerHour} an hour`],
  ["Kept per run", "16 KB of output per step, 64 KB per run, the last 100 log lines"],
];

export function DocsPage() {
  const { state } = useSession();
  const signedIn = state.status === "signed-in";

  useEffect(() => {
    const prev = document.title;
    document.title = "Docs · Knotwork";
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <div className="min-h-screen bg-ink">
      <header className="sticky top-0 z-30 border-b border-line bg-ink/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-3" aria-label="Knotwork, front page">
              <Logo size={28} />
              <span className="font-display text-lg font-bold tracking-tight">knotwork</span>
            </Link>
            <span className="font-mono text-xs tracking-[0.12em] text-muted uppercase">Docs</span>
          </div>
          <Link
            href={signedIn ? "/home" : "/demo"}
            className="inline-flex h-10 items-center rounded-full bg-text px-4 text-sm font-semibold text-ink transition-colors hover:bg-soft"
          >
            {signedIn ? "Open Knotwork" : "Try the demo"}
          </Link>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1200px] grid-cols-[minmax(0,1fr)] gap-12 px-4 py-12 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:py-16">
        <nav aria-label="On this page" className="hidden lg:block">
          <ul className="sticky top-28 m-0 flex list-none flex-col gap-1 p-0">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="block rounded-lg px-3 py-2 text-sm text-soft transition-colors hover:bg-graphite hover:text-text">
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <main className="docs max-w-[720px]">
          <p className="font-mono text-xs tracking-[0.12em] text-muted uppercase">User guide</p>
          <h1 className="mt-3 font-display text-[40px] leading-[1.05] font-bold tracking-tight text-balance sm:text-[56px]">
            How to use Knotwork
          </h1>
          <details className="toc lg:hidden">
            <summary>On this page</summary>
            <ul>
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>{s.label}</a>
                </li>
              ))}
            </ul>
          </details>
          <p className="lead">
            Knotwork runs a list of steps when something happens: a webhook arrives, a schedule comes round, or you press Run.
            If a step fails it waits and tries again, and every attempt is in the run log.
          </p>

          <Section id="start" title="Get started">
            <ol>
              <li>
                <Link href="/signup">Create an account</Link> with a name, an email and a password of at least 10 characters.
                There is no email to confirm. Or open the <Link href="/demo">demo account</Link>, which needs nothing.
              </li>
              <li>
                Press <b>New workflow</b>. Pick a trigger, add steps, and press <b>Create</b> (later, <b>Save</b>).
              </li>
              <li>
                Press <b>Run now</b>, type some test input if you like, and press <b>Run</b> (<b>Save and run</b> when there are unsaved changes). The run page shows each step as it lands.
              </li>
            </ol>
            <p>
              A workflow only starts on its own (from its schedule or webhook) while the box{" "}
              <b>On (schedules and webhooks start runs)</b> in the editor's side panel is ticked.
            </p>
          </Section>

          <Section id="editor" title="The editor">
            <p>
              A workflow opens on the <b>canvas</b>: the trigger on top, one box per step, and a <b>+</b> in every gap. Press a{" "}
              <b>+</b> to add a step there, and press a box to change it in the panel beside the canvas (on a phone, a sheet
              from the bottom). Drag the background to move around; pinch, hold Ctrl and scroll, or use the buttons in the
              corner to zoom. The <b>Canvas / List</b> switch at the top shows the same steps as a plain list, and your choice
              is remembered.
            </p>
            <dl>
              <dt>Move a step</dt>
              <dd>Drag its box onto another <b>+</b>, or press it and use <b>Move up</b> and <b>Move down</b> in the panel.</dd>
              <dt>Test one step</dt>
              <dd>
                Press a step, open its <b>Test</b> tab and press <b>Test this step</b>. Only that step runs, against the test
                data shown, which you can type or fill with <b>Use the last run's data</b>. Nothing is saved, no run is
                started, and a delay doesn't wait. A step that passes adds its output to the test data, so you can test your
                way down. Testing an if says which way it would go; testing a loop says what it would go through and
                sets its first item as <code>loop.item</code>, so the steps inside can be tested next. A step that uses a
                secret really sends it; the answer shows <code>[secret NAME]</code>. You get {LIMITS.stepTestsPerHour} tests an hour.
              </dd>
              <dt>Version history</dt>
              <dd>
                Every save keeps a copy, the newest {LIMITS.versionsPerWorkflow} of them. Open <b>History</b> in the panel (with
                no step selected) and pick a version to see it on the canvas. <b>Restore this version</b> puts it in the editor;
                it replaces the current one only when you press <b>Save</b>.
              </dd>
              <dt>Ready-made workflows</dt>
              <dd>
                <b>Templates</b> in the sidebar holds {TEMPLATES.length} workflows that run as they are. One opens on the canvas
                unsaved, so nothing is created until you press <b>Create</b>. (These are not the <code>{"{{ }}"}</code>{" "}
                templates described below.)
              </dd>
              <dt>Export and import</dt>
              <dd>
                <b>Export as a file</b> in the panel saves the trigger and steps as a small JSON file. <b>Import a file</b> on the
                Workflows and Templates pages opens such a file as a new, unsaved workflow, checked the same way as a save.
                The file holds whatever you typed into the steps, API keys in headers included, so look it over before you
                share it.
              </dd>
            </dl>
          </Section>

          <Section id="triggers" title="Triggers">
            <p>Every workflow has one trigger. It decides how runs start and what <code>trigger</code> holds in templates.</p>
            <dl>
              <dt>Manual</dt>
              <dd>
                Run it from the editor. The test input you type (JSON) becomes <code>trigger.body</code>. Every workflow can be
                run by hand, whatever its trigger.
              </dd>
              <dt>Webhook</dt>
              <dd>
                Once the workflow is saved, the editor shows its private URL. Any service can call it, with any method; the
                random key in the URL is the secret, so treat it like a password. JSON and form bodies are parsed; anything
                else arrives as text. In templates you get <code>trigger.body</code>, <code>trigger.query</code>,{" "}
                <code>trigger.headers</code> and <code>trigger.method</code>. The <code>cookie</code> and{" "}
                <code>authorization</code> headers are never kept. The call answers <code>202</code> with the new run's id
                straight away; the steps run after that. Invalid JSON answers <code>400</code>, and a body over{" "}
                {LIMITS.runInputBytes / 1000} KB answers <code>413</code>.
                <pre>{`curl -X POST https://knotwork.gigiberidze.com/hooks/<your key> \\
  -H 'content-type: application/json' \\
  -d '{"id": "order_1", "amount": 120}'`}</pre>
              </dd>
              <dt>Webhook with a signature check</dt>
              <dd>
                A webhook can refuse every call that wasn't signed by <b>GitHub</b> or <b>Stripe</b>. Save the signing
                secret under Settings, then Secrets, and pick it in the trigger next to <b>Check the sender's signature</b>.
                On GitHub: the repository's Settings, Webhooks, Add webhook, with this workflow's URL, content type{" "}
                <code>application/json</code> and the same secret. On Stripe: Developers, Webhooks, add an endpoint with the
                URL and save its signing secret (<code>whsec_…</code>, the whole text). A call without a valid signature
                answers <code>401</code> and starts no run, so nothing shows here; GitHub's Recent Deliveries and Stripe's
                delivery attempts show the answer and why.
              </dd>
              <dt>Schedule</dt>
              <dd>
                A cron expression with five fields (minute, hour, day of month, month, weekday), always in <b>UTC</b>. The
                shortest gap is {LIMITS.minScheduleMinutes} minutes. <code>0 9 * * 1</code> means Mondays at 9:00 UTC. A
                scheduled run gets <code>trigger.scheduledFor</code>, the minute it was due.
              </dd>
            </dl>
          </Section>

          <Section id="steps" title="Steps">
            <p>
              Steps run in order. Each has an <b>id</b> (up to 40 lowercase letters, digits and <code>_</code>, starting with a letter), and later steps read its
              result as <code>steps.&lt;id&gt;</code>.
            </p>
            <dl>
              <dt>HTTP request</dt>
              <dd>
                Calls any public API: method, URL, headers and a body (JSON or text). Its result is{" "}
                <code>{"{ status, ok, headers, body }"}</code>, with <code>body</code> parsed when the answer is JSON. A 4xx or
                5xx answer counts as a failure (and is retried) unless you untick <b>Treat a 4xx or 5xx answer as a failure</b>. Private and internal
                addresses can't be called.
              </dd>
              <dt>Transform</dt>
              <dd>Builds a new value from earlier data. Write any JSON; every string in it can hold templates. The result is the JSON you wrote, filled in.</dd>
              <dt>Filter</dt>
              <dd>
                Stops the run quietly unless a condition holds: <code>equals</code>, <code>not_equals</code>,{" "}
                <code>contains</code>, <code>gt</code>, <code>lt</code>, <code>exists</code>, <code>not_exists</code>. A run
                stopped by a filter is not a failure.
              </dd>
              <dt>Delay</dt>
              <dd>Parks the run for a number of seconds, up to 7 days, then carries on. Nothing is held in memory while it waits.</dd>
              <dt>Log</dt>
              <dd>Writes a line, with templates, to the run log.</dd>
              <dt>Slack, Discord, Telegram, GitHub</dt>
              <dd>
                Ready-made steps with their own forms. <b>Slack</b> and <b>Discord</b> post to a channel webhook,{" "}
                <b>Telegram</b> sends as your bot (from @BotFather) to a chat id or <code>@channel</code>, and <b>GitHub</b> opens an
                issue, comments on an issue or pull request, or reads a repository (no token needed for a public one). Put the
                webhook URL or token in a workspace secret and write <code>{"{{ secrets.NAME }}"}</code> in its field; a pasted value
                works too and is shown hidden. They call only their own service and never repeat the credential in the run log.
                Mass pings (<code>@everyone</code>, <code>@channel</code>) from template text are switched off. Results: Discord{" "}
                <code>messageId</code>, Telegram <code>messageId</code>, GitHub issue <code>number</code> and <code>url</code>, or a
                repository's <code>stars</code>, <code>forks</code> and more.
              </dd>
            </dl>
          </Section>

          <Section id="blocks" title="If / else and loops">
            <p>Two steps are blocks: they hold steps of their own. Blocks can sit inside blocks, {LIMITS.stepDepth} levels deep.</p>
            <dl>
              <dt>If / else</dt>
              <dd>
                Checks a condition (the same ones a filter has) and runs its <b>Then</b> steps when it holds, its <b>Else</b>{" "}
                steps when it doesn't. Either side can be empty. Later steps can read <code>steps.&lt;id&gt;.result</code>{" "}
                (true or false). Unlike a filter, the run carries on after the block either way.
              </dd>
              <dt>Loop</dt>
              <dd>
                Runs its steps once for each item of a list, up to {LIMITS.loopItems} items. Give it one template that is a
                list, like <code>{"{{ trigger.body.orders }}"}</code>. Inside, <code>{"{{ loop.item }}"}</code> is the
                current item, <code>{"{{ loop.index }}"}</code> its position counted from 0, and{" "}
                <code>{"{{ loop.count }}"}</code> the length of the list. A longer list, or something that isn't a list,
                fails the step; nothing is cut short silently.
              </dd>
            </dl>
            <p>
              Each pass starts clean: a step inside a loop holds its result for the current item only, and after the loop
              only the last pass is left. To keep something from every item, send it somewhere inside the loop. A filter
              inside a block still stops the whole run; to skip one item, use an if.
            </p>
            <p>
              A run can take {LIMITS.stepRunsPerRun} steps in all. Every time a step runs counts: each step in each pass of
              a loop, each retry, each if check and each start of a loop. So {LIMITS.loopItems} items with 3 steps inside is
              151, and with 4 steps it is 201, one too many. A run also makes at most {LIMITS.httpCallsPerGo} requests to
              other sites in one go (a redirect counts as one more): a longer loop of requests pauses, says so, and carries
              on, usually within a minute (longer when many runs are making requests at once).
            </p>
            <p>An example that takes a signed GitHub push, and posts each commit by someone other than a bot to a chat:</p>
            <pre>{`Trigger: Webhook, signature check: GitHub, secret GH_SIGNING
1. If       {{ trigger.headers.x-github-event }} equals push
   Then:
   2. Loop  {{ trigger.body.commits }}
      3. If {{ loop.item.author.name }} not_equals dependabot[bot]
         Then:
         4. HTTP request  POST {{ secrets.CHAT_URL }}
            body { "text": "{{ loop.item.message }}" }`}</pre>
          </Section>

          <Section id="secrets" title="Secrets">
            <p>
              Keep API keys, tokens and chat webhook URLs under <b>Settings, then Secrets</b>, not in the workflow. A step
              uses one as <code>{"{{ secrets.SLACK_URL }}"}</code>. Names are capitals, digits and <code>_</code>. A value is
              stored encrypted and can't be shown again; to change it, save it again. In a team, the owner and editors
              manage secrets and viewers see only their names. Anyone who can edit a workflow can use a secret in a
              request to any address, so after removing an editor, replace the secrets they could use.
            </p>
            <p>
              Wherever a secret's value would show up in a run (a log line, an output, an error), you see{" "}
              <code>[secret SLACK_URL]</code> instead. Later steps see the mark too, so use the secret where it is needed,
              not through another step's output. Two things are not hidden: what the trigger received (a webhook's body
              and headers are kept as they arrived) and what a step sends out. A step that names a secret that isn't set
              fails and says which one. Each workspace has its own secrets, and the shared demo account can't keep any.
            </p>
          </Section>

          <Section id="templates" title="Templates">
            <p>
              Put <code>{"{{ path }}"}</code> in any text field to use data from the trigger or an earlier step. Paths are dotted,
              and list items are numbers:
            </p>
            <pre>{`{{ trigger.body.order.id }}
{{ steps.fetch.body.items.0.name }}
{{ run.id }}  {{ workflow.name }}`}</pre>
            <p>
              A field that is <b>only</b> one template keeps the value's type, so <code>{"{{ trigger.body.items }}"}</code> stays a
              list and a number stays a number. Inside other text, the value is written out as text. A path that doesn't exist
              gives an empty value.
            </p>
            <p>Templates are plain lookups. Nothing is calculated or run, so there is no way to run code in a workflow.</p>
          </Section>

          <Section id="retries" title="Retries and delays">
            <p>
              Each step has two retry settings: <b>Retries if it fails</b> (0 to 5 extra attempts) and <b>First wait (seconds)</b>.
              Every later wait is four times longer, so 5 seconds gives 5 s, 20 s, 80 s.
            </p>
            <p>
              Waiting runs are picked up by a check that runs every minute, so a retry or a delay can finish up to a minute
              after its time. On a waiting run's page, <b>Check now</b> moves it along without waiting for that minute.
            </p>
          </Section>

          <Section id="runs" title="Runs">
            <p>
              A run is <b>Queued</b>, then <b>Running</b>, maybe <b>Waiting</b> (in a delay or before a retry), and ends{" "}
              <b>Passed</b>, <b>Failed</b> or <b>Stopped by filter</b>. The run page lists every attempt of every step,
              with its output, its message and how long it took, and the input that started it. <b>Run again</b> on a
              finished run starts a new one with the same input, on the workflow as it is now; it counts as a manual run.
            </p>
            <p>
              A run saves its place as it goes, always before and after a step that reaches outside. If anything cuts it
              off halfway, it continues from there on the next minute. If your account has used its storage budget for the hour, a run shows <b>Paused</b> before its next step
              (the run page says why) and tries again within 10 minutes or at the next hour. Runs are kept for{" "}
              {LIMITS.runHistoryDays} days after they start, or after they wake from their last wait; workflows stay until you
              delete them.
            </p>
          </Section>

          <Section id="workspaces" title="Workspaces and account">
            <p>
              Every account has a <b>Personal</b> workspace and can make {LIMITS.workspacesPerAccount - 1} more from the sidebar.
              Each workspace has its own workflows and runs. Personal can be renamed but not deleted.
            </p>
            <p>
              In <b>Settings</b> you can change your password or delete your account. Deleting removes every workspace, workflow
              and run, and can't be undone.
            </p>
            <p>
              Knotwork sends no email, so a forgotten password can't be reset yet. Keep it in a password manager.
            </p>
          </Section>

          <Section id="demo" title="The demo account">
            <p>
              Anyone can open the demo, so it is shared: what you change, the next visitor sees. It comes with three example
              workflows and is put back the way it was every day at 03:00 UTC. Its runs per hour are shared by everyone in it. Its settings can't be changed, and its HTTP steps can only
              call a few test APIs (<code>api.github.com</code>, <code>httpbin.org</code>, <code>jsonplaceholder.typicode.com</code>,{" "}
              <code>postman-echo.com</code>, <code>example.com</code>). Make your own account to call anything else.
            </p>
          </Section>

          <Section id="limits" title="Limits">
            <p>Knotwork is free and open to anyone, so each account has limits that keep one person from using up the free plan for everyone.</p>
            <table>
              <tbody>
                {LIMIT_ROWS.map(([what, value]) => (
                  <tr key={what}>
                    <th scope="row">{what}</th>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              When the whole service gets busy, accounts that have already used a lot this hour wait first. If storage gets
              close to full, the oldest run history is trimmed, and new runs and sign-ups pause until there is room.
            </p>
          </Section>

          <Section id="help" title="Problems and answers">
            <dl>
              <dt>My schedule didn't run on time</dt>
              <dd>Schedules are in UTC and checked once a minute. Check the workflow is On.</dd>
              <dt>My webhook answers 404</dt>
              <dd>The URL changed or the workflow's trigger isn't Webhook any more. Copy the URL from the editor again.</dd>
              <dt>My webhook answers 409</dt>
              <dd>The workflow is turned off.</dd>
              <dt>My webhook answers 401</dt>
              <dd>
                Its signature check refused the call: the signing secret here and in the service differ, the secret isn't
                in this workspace, or (Stripe) the call was signed more than 5 minutes ago. The answer says which. Save the
                secret again on both sides.
              </dd>
              <dt>A step fails with "The secret … isn't set"</dt>
              <dd>
                The step names a secret this workspace doesn't have. Add it under Settings, then Secrets; each workspace has
                its own. If it says the secret "can't be read any more", save its value again.
              </dd>
              <dt>A run says "Paused: … as many requests as fit"</dt>
              <dd>
                It made {LIMITS.httpCallsPerGo} requests in one go, or many runs were making requests in the same minute.
                Nothing is lost: it carries on from the same step, usually within a minute and a little later when many runs are busy.
              </dd>
              <dt>A run fails with "The run reached {LIMITS.stepRunsPerRun} steps"</dt>
              <dd>
                Every step in every pass of a loop counts, and every retry. Loop over fewer items, put fewer steps inside,
                or split the work over several runs.
              </dd>
              <dt>A run answers 429 or won't start</dt>
              <dd>You reached a limit above. Runs per hour reset at the start of each clock hour.</dd>
              <dt>Saving says "This workflow was saved somewhere else"</dt>
              <dd>
                It changed in another tab or on another device after you opened it. <b>Keep mine</b> saves your version over
                theirs; <b>Load theirs</b> drops your changes and shows theirs.
              </dd>
              <dt>A template comes out empty</dt>
              <dd>The path doesn't match the data. Open a past run and look at the step's output to see the real shape.</dd>
              <dt>A step fails with "templates add up to more than 64 KB"</dt>
              <dd>Everything one step fills in from templates is capped at 64 KB. Pass a smaller part of the data, not all of it.</dd>
            </dl>
            <p>
              Something else? <a href="https://github.com/GigiBeridzeAxal/knotwork/issues">Open an issue on GitHub</a>.
            </p>
          </Section>
        </main>
      </div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24">
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  );
}
