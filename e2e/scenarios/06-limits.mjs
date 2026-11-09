import { api, cleanup, logWorkflow, personal } from "./kw.mjs";

export default {
  name: "Workspace limits are per workspace and per account",
  tags: ["limits"],
  actors: ["frank", "erin"],
  expectedHttp: [409],
  async run({ actors: { frank, erin }, step, check, sees, runTag, data }) {
    await step(frank, "fills his Personal workspace to 10 workflows", async ({ page }) => {
      await page.goto("/home");
      data.ws = await personal(frank);
      const have = (await api(frank, "GET", "/workflows", undefined, data.ws)).body.length;
      for (let i = have; i < 10; i++) await api(frank, "POST", "/workflows", logWorkflow(`${runTag} fill ${i}`), data.ws);
    });
    await step(frank, "the 11th is refused with a clear message", async () => {
      const res = await api(frank, "POST", "/workflows", logWorkflow(`${runTag} one too many`), data.ws);
      check(res.status === 409 && /10 workflows/.test(res.body?.error), `11th workflow gave ${res.status} ${res.body?.error}`);
    });
    await step(frank, "the + box is disabled and says why", async ({ page }) => {
      await page.reload();
      await page.getByLabel(/workspace is full/).first().waitFor();
    });
    await step(frank, "can't make more than 5 workspaces", async () => {
      const results = [];
      for (let i = 0; i < 5; i++) results.push((await api(frank, "POST", "/workspaces", { name: `${runTag.slice(-4)} extra ${i}` })).status);
      check(results.filter((s) => s === 201).length === 4 && results[4] === 409, `workspace creates gave ${results}`);
    });
    await step(erin, "is unaffected: she can still add a workflow", async ({ page }) => {
      await page.goto("/home");
      const ws = await personal(erin);
      const res = await api(erin, "POST", "/workflows", logWorkflow(`${runTag} erin`), ws);
      check(res.status === 201, `erin's create gave ${res.status}`);
      await cleanup(erin, runTag);
    });
    await step(frank, "cleans up", () => cleanup(frank, runTag));
  },
};
