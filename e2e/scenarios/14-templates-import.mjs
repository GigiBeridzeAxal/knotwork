import fs from "node:fs";
import { api, cleanup, personal } from "./kw.mjs";

export default {
  name: "A template opens on the canvas unsaved; an exported file imports into another account",
  tags: ["templates", "import"],
  actors: ["bob", "carol"],
  async run({ actors: { bob, carol }, step, check, runTag, data }) {
    await step(bob, "filters the templates and opens one: nothing is saved yet", async ({ page }) => {
      await page.goto("/templates");
      await page.getByRole("button", { name: "Webhooks", exact: true }).click();
      check((await page.getByRole("link", { name: /Uptime check/ }).count()) === 0, "the Webhooks filter still shows a Monitoring template");
      await page.getByRole("link", { name: /Webhook relay/ }).click();
      await page.waitForURL(/\/workflows\/new\?template=webhook-relay/);
      await page.locator("[data-step]").first().waitFor();
      check((await page.locator("[data-step]").count()) === 3, "the template's three steps aren't on the canvas");
      data.ws = await personal(bob);
      const list = (await api(bob, "GET", "/workflows", undefined, data.ws)).body;
      check(!list.some((w) => w.name === "Webhook relay"), "opening a template already saved a workflow");
    });
    await step(bob, "renames it, creates it, and exports it as a file", async ({ page }) => {
      await page.locator("#wf-name").fill(`${runTag} relay`);
      await page.getByRole("button", { name: "Create" }).click();
      await page.waitForURL(/\/workflows\/wf_/);
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export as a file" }).click()]);
      data.file = await download.path();
      const exported = JSON.parse(fs.readFileSync(data.file, "utf8"));
      check(exported.workflow?.steps?.length === 3, "the exported file doesn't hold the three steps");
      check(!JSON.stringify(exported).includes("hookKey") && !/hooks\//.test(JSON.stringify(exported)), "the exported file holds the webhook URL");
      check(download.suggestedFilename().endsWith(".knotwork.json"), `the file is called ${download.suggestedFilename()}`);
    });
    await step(carol, "imports a file that isn't a workflow and is told so", async ({ page }) => {
      await page.goto("/workflows");
      await page.getByLabel("Workflow file to import").setInputFiles({ name: "notes.json", mimeType: "application/json", buffer: Buffer.from('{"hello":"world"}') });
      await page.getByText(/isn't a Knotwork workflow/).waitFor();
      check(page.url().endsWith("/workflows"), "a bad file still opened the editor");
    });
    await step(carol, "imports bob's file: it opens unsaved, and Create makes it hers", async ({ page }) => {
      await page.getByLabel("Workflow file to import").setInputFiles(data.file);
      await page.waitForURL(/\/workflows\/new\?import/);
      await page.locator("[data-step]").first().waitFor();
      check((await page.locator("#wf-name").inputValue()) === `${runTag} relay`, "the imported workflow's name isn't in the editor");
      check((await page.locator("[data-step]").count()) === 3, "the imported steps aren't on the canvas");
      await page.getByRole("button", { name: "Create" }).click();
      await page.waitForURL(/\/workflows\/wf_/);
      const ws = await personal(carol);
      const mine = (await api(carol, "GET", "/workflows", undefined, ws)).body.find((w) => w.name === `${runTag} relay`);
      check(mine && mine.steps.length === 3, "carol's workspace doesn't have the imported workflow");
      check(mine?.hookKey && mine.hookKey !== (await api(bob, "GET", "/workflows", undefined, data.ws)).body.find((w) => w.name === `${runTag} relay`)?.hookKey, "the import shares bob's webhook URL");
    });
    await step(bob, "cleans up", () => cleanup(bob, runTag));
    await step(carol, "cleans up", () => cleanup(carol, runTag));
  },
};
