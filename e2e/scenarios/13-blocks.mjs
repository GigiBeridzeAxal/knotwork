import { api, cleanup, personal } from "./kw.mjs";

export default {
  name: "A loop with an if inside is built in the editor, saved, and runs once per item, on desktop and phone",
  tags: ["blocks", "mobile"],
  actors: ["alice", "erin"],
  async run({ actors: { alice, erin }, step, check, sees, runTag, data }) {
    await step(alice, "builds a loop that holds an if, with a step in each branch", async ({ page }) => {
      await page.goto("/workflows/new");
      await page.locator("#wf-name").fill(`${runTag} blocks`);
      await page.getByRole("button", { name: /^Loop/ }).click();
      await page.getByLabel("List to go through").fill("{{ trigger.body.orders }}");
      const each = page.getByRole("group", { name: "Loop: For each item" });
      await each.getByRole("button", { name: "+ Add step" }).click();
      await each.getByRole("button", { name: /^If \/ else/ }).click();
      await each.getByLabel("Value").fill("{{ loop.item.amount }}");
      await each.getByLabel("Compare with").fill("100");
      const then = each.getByRole("group", { name: "If: Then" });
      await then.getByRole("button", { name: "+ Add step" }).click();
      await then.getByRole("button", { name: /^Log/ }).click();
      await then.getByLabel("Message").fill("Big order {{ loop.item.id }}");
      const otherwise = each.getByRole("group", { name: "If: Else" });
      await otherwise.getByRole("button", { name: "+ Add step" }).click();
      await otherwise.getByRole("button", { name: /^Log/ }).click();
      await otherwise.getByLabel("Message").fill("Small order {{ loop.item.id }}");
      await page.getByRole("button", { name: "Create" }).click();
      await page.waitForURL(/\/workflows\/wf_/);
      data.id = page.url().split("/").pop();
      data.ws = await personal(alice);
    });
    await step(alice, "finds the nested steps saved the way she built them", async () => {
      const wf = (await api(alice, "GET", `/workflows/${data.id}`, undefined, data.ws)).body;
      const loop = wf.steps[0];
      check(loop?.type === "loop" && loop.steps[0]?.type === "if", `saved steps: ${JSON.stringify(wf.steps).slice(0, 300)}`);
      check(loop.steps[0].then.length === 1 && loop.steps[0].else.length === 1, "the if's branches don't hold one step each");
    });
    await step(alice, "runs it with three orders and reads one line per item, on the right branch", async ({ page }) => {
      await page.getByRole("button", { name: "Run now" }).click();
      await page.locator("#run-input").fill('{ "orders": [{ "id": "a1", "amount": 250 }, { "id": "a2", "amount": 20 }, { "id": "a3", "amount": 101 }] }');
      await page.getByRole("button", { name: /^Run$/ }).click();
      await page.waitForURL(/\/runs\//, { timeout: 15000 });
      data.run = page.url().split("/").pop();
      await sees(alice, "Going through 3 items");
      await sees(alice, "Big order a1");
      await sees(alice, "Small order a2");
      await sees(alice, "Big order a3");
      await sees(alice, "3 of 3", { exact: false });
      const run = (await api(alice, "GET", `/runs/${data.run}`, undefined, data.ws)).body;
      check(run.status === "succeeded", `the run ended ${run.status}: ${run.error}`);
      check(run.logs.length === 7, `expected 7 log lines (1 loop, 3 ifs, 3 logs), got ${run.logs.length}`);
    });
    await step(alice, "runs it with something that isn't a list and is told so", async ({ page }) => {
      const { runId } = (await api(alice, "POST", `/workflows/${data.id}/run`, { input: { orders: "none" } }, data.ws)).body;
      await page.goto(`/runs/${runId}`);
      await sees(alice, "not a list");
      await sees(alice, "Failed");
    });
    await step(erin, "builds a block on her phone with no sideways scroll", async ({ page }) => {
      await page.goto("/workflows/new");
      await page.locator("#wf-name").fill(`${runTag} phone blocks`);
      await page.getByRole("button", { name: /^If \/ else/ }).click();
      const then = page.getByRole("group", { name: "If: Then" });
      await then.getByRole("button", { name: "+ Add step" }).click();
      await then.getByRole("button", { name: /^Loop/ }).click();
      const each = then.getByRole("group", { name: "Loop: For each item" });
      await each.getByRole("button", { name: "+ Add step" }).click();
      // Three levels deep is the limit, so blocks aren't offered here any more.
      check((await each.getByRole("button", { name: /^(Loop|If \/ else)/ }).count()) === 0, "a fourth level of blocks is offered");
      await each.getByRole("button", { name: /^Log/ }).click();
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(wide <= 0, `the editor scrolls sideways by ${wide}px`);
      await page.getByRole("button", { name: "Create" }).click();
      await page.waitForURL(/\/workflows\/wf_/);
      await cleanup(erin, runTag);
      await cleanup(alice, runTag);
    });
  },
};
