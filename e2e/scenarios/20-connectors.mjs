import { api, cleanup, personal } from "./kw.mjs";

// Ready-made steps (phase 4). Calls go out to discord.com, api.telegram.org and api.github.com with
// fake credentials. Where the test machine can reach them, the service's 401/404 proves the request was
// built and sent; where it can't (no DNS for local workerd in the cloud sandbox), the network error must
// still name the right host and never the credential. Set BST_NET=1 to require real answers.
const NET = process.env.BST_NET === "1";
const reached = (re, text) => (NET ? re : new RegExp(`${re.source}|failed:`)).test(text ?? "");
const FAKE_DISCORD = "https://discord.com/api/webhooks/1234567890/FAKEtokenFAKEtokenFAKE";
const FAKE_BOT = "123456789:AAFAKEFAKEFAKEFAKEFAKEFAKEFAKE12345";

async function waitRun(a, ws, runId) {
  for (let i = 0; i < 40; i++) {
    const r = (await api(a, "GET", `/runs/${runId}`, undefined, ws)).body;
    if (r && ["succeeded", "failed", "stopped"].includes(r.status)) return r;
    await a.page.waitForTimeout(500);
  }
  throw new Error("run did not finish in 20s");
}

export default {
  name: "Ready-made steps: GitHub star to Discord template, every form saves, phone fits, real calls go out",
  tags: ["happy", "lifecycle", "device"],
  actors: ["alice", "bob", "carol", "erin"],
  async run({ actors: { alice, bob, carol, erin }, step, check, runTag, data, note }) {
    await step(alice, "opens the 'New GitHub star to Discord' template and switches to the list view", async ({ page }) => {
      await page.goto("/home");
      data.aws = await personal(alice);
      await page.goto("/templates");
      await page.getByRole("link", { name: /New GitHub star to Discord/ }).click();
      await page.waitForURL(/\/workflows\/new\?template=github-star-to-discord/);
      await page.locator("[data-step]").first().waitFor();
      check((await page.locator("[data-step]").count()) === 2, "the template's two steps aren't on the canvas");
      await page.getByRole("button", { name: "list", exact: true }).click();
    });
    await step(alice, "sees the Discord form with the secret placeholder and the step's message", async ({ page }) => {
      await page.getByRole("button", { name: /Tell Discord/ }).click();
      const hook = page.getByLabel("Webhook URL");
      check((await hook.inputValue()) === "{{ secrets.DISCORD_WEBHOOK }}", `webhook field holds "${await hook.inputValue()}"`);
      check((await hook.getAttribute("type")) === "text", "a template is shown, not hidden");
      check((await page.getByLabel("Message").inputValue()).includes("starred"), "message template is there");
    });
    await step(alice, "pastes a (fake) Discord webhook, which is then hidden, renames and saves", async ({ page }) => {
      await page.getByLabel("Webhook URL").fill(FAKE_DISCORD);
      await page.getByLabel("Retries if it fails").selectOption("0");
      check((await page.getByLabel("Webhook URL").getAttribute("type")) === "password", "a pasted webhook URL is hidden");
      await page.locator("#wf-name").fill(`${runTag} star`);
      await page.getByRole("button", { name: "Create" }).click();
      await page.waitForURL(/\/workflows\/wf_/);
      data.awf = page.url().split("/workflows/")[1].split(/[?#]/)[0];
    });
    await step(alice, "GitHub-style star webhook arrives; the run reaches Discord, which rejects the fake hook", async ({ page }) => {
      const wf = (await api(alice, "GET", `/workflows/${data.awf}`, undefined, data.aws)).body;
      const res = await page.evaluate(async (key) => {
        const r = await fetch(`/hooks/${key}`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "star" },
          body: JSON.stringify({ action: "created", sender: { login: "octocat" }, repository: { full_name: "o/r", stargazers_count: 42 } }) });
        return { status: r.status, body: await r.json().catch(() => null) };
      }, wf.hookKey);
      check(res.status === 202, `webhook answered ${res.status}`);
      const run = await waitRun(alice, data.aws, res.body.runId);
      const log = run.logs.map((l) => `${l.stepId}:${l.status}:${l.message}`).join(" | ");
      note(`Run log: ${log}`);
      check(run.status === "failed" && /discord/i.test(run.error ?? "") && reached(/Discord answered (401|404)/, run.error), `run ${run.status}: ${run.error}`);
      check(!JSON.stringify(run).includes("FAKEtoken"), "the webhook token shows up in the run");
    });
    await step(alice, "a non-star event is filtered out before Discord", async ({ page }) => {
      const wf = (await api(alice, "GET", `/workflows/${data.awf}`, undefined, data.aws)).body;
      const runId = await page.evaluate(async (key) => (await (await fetch(`/hooks/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "deleted" }) })).json()).runId, wf.hookKey);
      const run = await waitRun(alice, data.aws, runId);
      check(run.status === "stopped", `run is ${run.status}`);
    });

    await step(bob, "adds Slack, Discord, Telegram and GitHub steps from the picker", async ({ page }) => {
      data.bws = await personal(bob);
      data.bwf = (await api(bob, "POST", "/workflows", { name: `${runTag} four`, description: "", enabled: true, trigger: { type: "manual" }, steps: [] }, data.bws)).body.id;
      await page.goto(`/workflows/${data.bwf}`);
      await page.getByRole("button", { name: "list", exact: true }).click();
      for (const label of ["Slack", "Discord", "Telegram", "GitHub"]) {
        await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
      }
      check((await page.getByText(/Step 4 · GitHub/).count()) === 1, "four steps added");
    });
    await step(bob, "fills the GitHub step: comment on an issue, with templates", async ({ page }) => {
      // The newest step is open after adding it.
      await page.getByLabel("Action").selectOption("add_comment");
      await page.getByLabel("Repository").fill("{{ trigger.body.repo }}");
      await page.getByLabel("Issue or pull request number").fill("{{ trigger.body.n }}");
      await page.getByLabel("Comment (Markdown)").fill("Seen by Knotwork");
      check(await page.getByLabel("Title").count() === 0, "title field hidden for comments");
    });
    await step(bob, "fills the Telegram step and saves", async ({ page }) => {
      await page.getByRole("button", { name: /Send on Telegram/ }).click();
      await page.getByLabel("Chat id").fill("-1001234567890");
      await page.getByLabel("Formatting").selectOption("HTML");
      await page.getByLabel("Send without a notification sound").check();
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    });
    await step(bob, "reloads and every setting is stored", async ({ page }) => {
      const wf = (await api(bob, "GET", `/workflows/${data.bwf}`, undefined, data.bws)).body;
      const by = Object.fromEntries(wf.steps.map((s) => [s.type, s.config]));
      check(by.github?.action === "add_comment" && by.github.number === "{{ trigger.body.n }}" && by.github.body === "Seen by Knotwork", `github ${JSON.stringify(by.github)}`);
      check(by.telegram?.chatId === "-1001234567890" && by.telegram.parseMode === "HTML" && by.telegram.silent === true, `telegram ${JSON.stringify(by.telegram)}`);
      check(by.slack?.webhookUrl === "{{ secrets.SLACK_WEBHOOK }}" && by.discord?.webhookUrl === "{{ secrets.DISCORD_WEBHOOK }}", "credential fields default to secrets");
      await page.reload();
      await page.getByRole("button", { name: "list", exact: true }).click();
      await page.getByRole("button", { name: /Send on Telegram/ }).click();
      check((await page.getByLabel("Chat id").inputValue()) === "-1001234567890", "form shows the stored chat id after reload");
    });

    await step(carol, "a Telegram step with a fake bot token reaches Telegram and keeps the token out of the run", async ({ page }) => {
      await page.goto("/home");
      data.cws = await personal(carol);
      const wf = { name: `${runTag} tg`, description: "", enabled: true, trigger: { type: "manual" }, steps: [
        { id: "tg", name: "Tell Telegram", type: "telegram", retry: { max: 0, backoffSeconds: 5 }, config: { botToken: FAKE_BOT, chatId: "42", text: "hi {{ trigger.body.who }}" } },
      ] };
      const id = (await api(carol, "POST", "/workflows", wf, data.cws)).body.id;
      const runId = (await api(carol, "POST", `/workflows/${id}/run`, { input: { who: "carol" } }, data.cws)).body.runId;
      const run = await waitRun(carol, data.cws, runId);
      note(`Telegram run: ${run.status}: ${run.error}`);
      check(run.status === "failed" && /telegram/i.test(run.error ?? "") && reached(/Telegram answered (401|404)/, run.error), `run ${run.status}: ${run.error}`);
      check(!JSON.stringify(run).includes("AAFAKEFAKE"), "the bot token shows up in the run");
    });
    await step(carol, "GitHub 'read a repository' on a public repo succeeds without a token", async ({ page }) => {
      const wf = { name: `${runTag} gh`, description: "", enabled: true, trigger: { type: "manual" }, steps: [
        { id: "repo", name: "Read repo", type: "github", retry: { max: 0, backoffSeconds: 5 }, config: { action: "get_repo", repo: "GigiBeridzeAxal/knotwork" } },
        { id: "say", name: "Say", type: "log", retry: { max: 0, backoffSeconds: 5 }, config: { message: "{{ steps.repo.fullName }} has {{ steps.repo.stars }} stars" } },
      ] };
      const id = (await api(carol, "POST", "/workflows", wf, data.cws)).body.id;
      const runId = (await api(carol, "POST", `/workflows/${id}/run`, {}, data.cws)).body.runId;
      const run = await waitRun(carol, data.cws, runId);
      note(`GitHub run: ${run.status}: ${run.logs.map((l) => l.message).join(" | ")}`);
      // Anonymous GitHub calls share one rate limit per IP; a 403 for that still proves the call went out.
      const limited = /GitHub answered 403: API rate limit/.test(run.error ?? "");
      if (limited) note("GitHub's anonymous rate limit was used up for this machine's IP; the request reached api.github.com.");
      if (!limited && (NET || run.status === "succeeded")) {
        check(run.status === "succeeded", `run ${run.status}: ${run.error}`);
        await page.goto(`/runs/${runId}`);
        await page.getByText(/has \d+ stars/).first().waitFor();
      } else if (!limited) {
        check(/api\.github\.com failed:/.test(run.error ?? ""), `run ${run.status}: ${run.error}`);
      }
    });

    await step(erin, "on a phone, the Telegram form fits the screen", async ({ page }) => {
      await page.goto("/home");
      data.ews = await personal(erin);
      const id = (await api(erin, "POST", "/workflows", { name: `${runTag} phone`, description: "", enabled: true, trigger: { type: "manual" }, steps: [] }, data.ews)).body.id;
      await page.goto(`/workflows/${id}`);
      await page.getByRole("button", { name: "list", exact: true }).click();
      await page.getByRole("button", { name: /^Telegram/ }).click();
      await page.getByLabel("Bot token").waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(overflow <= 0, `page is ${overflow}px wider than the screen`);
      await page.getByLabel("Bot token").scrollIntoViewIfNeeded();
    });

    await step(alice, "cleans up", () => cleanup(alice, runTag));
    await step(bob, "cleans up", () => cleanup(bob, runTag));
    await step(carol, "cleans up", () => cleanup(carol, runTag));
    await step(erin, "cleans up", () => cleanup(erin, runTag));
  },
};
