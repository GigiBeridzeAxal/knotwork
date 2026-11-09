import { api, cleanup, logWorkflow, personal } from "./kw.mjs";

export default {
  name: "Two tabs save the same workflow: the second is warned instead of overwriting",
  tags: ["concurrency", "sessions"],
  actors: ["alice"],
  expectedHttp: [409],
  async run({ actors: { alice }, step, together, check, sees, runTag, data, note }) {
    let tab2;
    await step(alice, "creates a workflow and opens it in two tabs", async ({ page }) => {
      await page.goto("/home");
      data.ws = await personal(alice);
      data.id = (await api(alice, "POST", "/workflows", logWorkflow(`${runTag} race`), data.ws)).body.id;
      tab2 = await alice.newTab();
      await Promise.all([page.goto(`/workflows/${data.id}`), tab2.goto(`/workflows/${data.id}`)]);
      await Promise.all([page.locator("#wf-name").waitFor(), tab2.locator("#wf-name").waitFor()]);
    });
    await step(alice, "renames it differently in each tab and saves both at once", async ({ page }) => {
      await page.locator("#wf-name").fill(`${runTag} A`);
      await tab2.locator("#wf-name").fill(`${runTag} B`);
      await Promise.all([page.getByRole("button", { name: "Save" }).click(), tab2.getByRole("button", { name: "Save" }).click()]);
    });
    await step(alice, "exactly one tab saved, the other shows the conflict warning", async ({ page }) => {
      const warn = "This workflow was saved somewhere else";
      await page.waitForTimeout(0);
      const [a, b] = [page, tab2];
      const waitEither = await Promise.race([
        a.getByText(warn).waitFor().then(() => "a"),
        b.getByText(warn).waitFor().then(() => "b"),
      ]);
      data.loser = waitEither === "a" ? a : b;
      data.winner = waitEither === "a" ? b : a;
      check((await data.winner.getByText(warn).count()) === 0, "both tabs show the conflict warning");
      const wf = (await api(alice, "GET", `/workflows/${data.id}`, undefined, data.ws)).body;
      check(wf.version === 2, `expected version 2 after one save, got ${wf.version}`);
      data.winnerName = wf.name;
    });
    await step(alice, "keeps her version in the warned tab, which saves on top", async () => {
      const mine = await data.loser.locator("#wf-name").inputValue();
      await data.loser.getByRole("button", { name: "Keep mine" }).click();
      await data.loser.getByRole("status").filter({ hasText: "Saved" }).waitFor();
      const wf = (await api(alice, "GET", `/workflows/${data.id}`, undefined, data.ws)).body;
      check(wf.name === mine && wf.version === 3, `after Keep mine: ${wf.name} v${wf.version}, expected ${mine} v3`);
      note(`Conflict handled: "${data.winnerName}" saved first, then "${mine}" was kept on purpose.`);
      await cleanup(alice, runTag);
    });
  },
};
