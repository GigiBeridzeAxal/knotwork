import { api, cleanup, me } from "./kw.mjs";

export default {
  name: "Workspaces: create one, add a workflow with the + box, switch by clicking",
  tags: ["workspaces", "sessions"],
  actors: ["alice", "bob"],
  expectedHttp: [404],
  async run({ actors: { alice, bob }, step, check, eventually, sees, doesNotSee, runTag, data }) {
    const wsName = `Side ${runTag.slice(-4)}`;
    await step(alice, "creates a workspace from the sidebar switcher", async ({ page }) => {
      await page.goto("/home");
      await page.getByRole("button", { name: /Personal/ }).first().click();
      await page.getByRole("menuitem", { name: "New workspace" }).click();
      await page.getByPlaceholder("Workspace name").fill(wsName);
      await page.getByRole("button", { name: "Create workspace" }).click();
      await page.getByRole("button", { name: wsName }).first().waitFor();
    });
    await step(alice, "adds a workflow to it with the + box", async ({ page }) => {
      await page.getByRole("link", { name: `New workflow in ${wsName}` }).click();
      await page.locator("#wf-name").fill(`${runTag} side flow`);
      await page.getByRole("button", { name: "Create" }).click();
      await page.waitForURL(/\/workflows\/wf_/);
      await page.getByRole("link", { name: `${runTag} side flow` }).first().waitFor();
    });
    await step(alice, "switches to Personal with one click and the side workflow is gone from the list", async ({ page }) => {
      await page.getByRole("button", { name: wsName }).first().click();
      await page.getByRole("menuitemradio", { name: "Personal" }).click();
      await page.waitForURL(/\/home$/);
      await page.getByRole("button", { name: "Personal", exact: true }).first().waitFor();
      await doesNotSee(alice, `${runTag} side flow`);
    });
    await step(alice, "switches back and it is there again", async ({ page }) => {
      await page.getByRole("button", { name: /Personal/ }).first().click();
      await page.getByRole("menuitemradio", { name: wsName }).click();
      await sees(alice, `${runTag} side flow`);
    });
    await step(alice, "opens a second tab: it remembers the last workspace", async () => {
      const tab = await alice.newTab();
      await tab.goto("/home");
      await tab.getByRole("button", { name: wsName }).first().waitFor();
      await tab.close();
    });
    await step(bob, "can't use alice's new workspace through the API", async () => {
      const ws = (await me(alice)).workspaces.find((w) => w.name === wsName);
      data.ws = ws.id;
      await bob.page.goto("/home");
      const res = await api(bob, "GET", "/workflows", undefined, ws.id);
      check(res.status === 404, `bob listing alice's workspace gave ${res.status}`);
    });
    await step(alice, "deletes the workspace in Settings; its workflow goes with it", async ({ page }) => {
      await page.goto("/settings");
      await page.getByRole("button", { name: "Delete workspace" }).click();
      await page.waitForURL(/\/home$/);
      await eventually(async () => (await me(alice)).workspaces.every((w) => w.name !== wsName), { timeout: 5000 });
      const res = await api(alice, "GET", "/workflows", undefined, data.ws);
      check(res.status === 404, `deleted workspace still answers: ${res.status}`);
      await cleanup(alice, runTag);
    });
  },
};
