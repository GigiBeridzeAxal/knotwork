import { api, cleanup, logWorkflow, personal } from "./kw.mjs";

export default {
  name: "An edit typed the moment the editor opens is kept, and saved",
  tags: ["lifecycle"],
  actors: ["alice"],
  async run({ actors: { alice }, step, check, runTag, data, note }) {
    await step(alice, "creates a workflow", async ({ page }) => {
      await page.goto("/home");
      data.ws = await personal(alice);
      data.id = (await api(alice, "POST", "/workflows", logWorkflow(`${runTag} early`), data.ws)).body.id;
    });
    await step(alice, "opens it with a full page load and renames it as soon as the name field appears", async ({ page }) => {
      data.loads = 0;
      page.on("request", (r) => {
        if (r.method() === "GET" && new URL(r.url()).pathname === `/api/workflows/${data.id}`) data.loads++;
      });
      await page.goto(`/workflows/${data.id}`);
      await page.locator("#wf-name").fill(`${runTag} early EDITED`);
    });
    await step(alice, "still sees the edit 3 seconds later", async ({ page }) => {
      await page.waitForTimeout(3000); // the point is that nothing replaces the edit while time passes
      const v = await page.locator("#wf-name").inputValue();
      note(`The editor loaded the workflow ${data.loads} time(s) on open.`);
      check(v === `${runTag} early EDITED`, `the name field went back to "${v}"`);
    });
    await step(alice, "saves, and the stored workflow has the new name", async ({ page }) => {
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
      const wf = (await api(alice, "GET", `/workflows/${data.id}`, undefined, data.ws)).body;
      check(wf.name === `${runTag} early EDITED`, `stored name is "${wf.name}"`);
    });
    await step(alice, "cleans up", () => cleanup(alice, runTag));
  },
};
