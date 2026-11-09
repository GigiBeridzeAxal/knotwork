import { api, cleanup, personal } from "./kw.mjs";

const step2 = (id, name, message) => ({ id, name, type: "log", retry: { max: 0, backoffSeconds: 5 }, config: { message } });

export default {
  name: "On the canvas: build a workflow, reorder it, run it; a phone edits a step in a sheet",
  tags: ["canvas", "mobile"],
  actors: ["alice", "erin"],
  async run({ actors: { alice, erin }, step, check, eventually, runTag, data }) {
    await step(alice, "starts a new workflow and adds two steps from the + on the canvas", async ({ page }) => {
      await page.goto("/workflows/new");
      await page.locator("#wf-name").fill(`${runTag} canvas`);
      await page.getByRole("button", { name: "Add the first step" }).click();
      await page.getByRole("menuitem", { name: /^Log/ }).click();
      await page.getByLabel("Message").fill("first");
      await page.getByRole("button", { name: "Add a step", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Transform/ }).click();
      await page.getByLabel("Name", { exact: true }).fill("Shape it");
      check((await page.locator("[data-step]").count()) === 2, "the canvas doesn't show two steps");
    });
    await step(alice, "moves the second step up with the panel's button, then drags it back down", async ({ page }) => {
      await page.getByRole("button", { name: "Move up" }).click();
      await eventually(async () => (await page.locator('[data-step="0"]').getAttribute("aria-label"))?.startsWith("Shape it"), {
        message: "Move up didn't put the step first",
      });
      const node = await page.locator('[data-step="0"]').boundingBox();
      const slot = await page.getByRole("button", { name: "Add a step", exact: true }).boundingBox();
      await page.mouse.move(node.x + node.width / 2, node.y + node.height / 2);
      await page.mouse.down();
      await page.mouse.move(slot.x + slot.width / 2, slot.y - 20, { steps: 12 });
      await page.mouse.move(slot.x + slot.width / 2, slot.y + slot.height / 2, { steps: 4 });
      await page.mouse.up();
      await eventually(async () => (await page.locator('[data-step="1"]').getAttribute("aria-label"))?.startsWith("Shape it"), {
        message: "dragging the step to the last + didn't move it",
      });
    });
    await step(alice, "creates it, and the stored steps are in the order the canvas shows", async ({ page }) => {
      await page.getByRole("button", { name: "Create" }).click();
      await page.waitForURL(/\/workflows\/wf_/);
      data.ws = await personal(alice);
      data.id = page.url().split("/").pop();
      const wf = (await api(alice, "GET", `/workflows/${data.id}`, undefined, data.ws)).body;
      check(wf.steps.map((s) => s.type).join() === "log,transform", `stored steps are ${wf.steps.map((s) => s.type).join()}`);
      check(wf.steps[0].config.message === "first", `the log message is stored as "${wf.steps[0].config.message}"`);
    });
    await step(alice, "runs it from the canvas view and it passes", async ({ page }) => {
      await page.getByRole("button", { name: "Run now" }).click();
      await page.getByRole("button", { name: /^Run$|Save and run/ }).last().click();
      await page.waitForURL(/\/runs\//, { timeout: 15000 });
      await eventually(async () => page.getByText("Passed").count(), { timeout: 15000 });
    });
    await step(alice, "switches to the list view and back, and both show the same steps", async ({ page }) => {
      await page.goto(`/workflows/${data.id}`);
      await page.locator("[data-step]").first().waitFor();
      await page.getByRole("button", { name: "list", exact: true }).click();
      await page.getByText("steps.log_1").waitFor();
      check((await page.locator("[data-step]").count()) === 0, "the canvas is still there in the list view");
      await page.getByRole("button", { name: "canvas", exact: true }).click();
      await page.locator("[data-step]").first().waitFor();
      check((await page.locator("[data-step]").count()) === 2, "the canvas lost a step after switching views");
    });
    await step(erin, "on a phone, taps a step, edits it in the sheet and saves", async ({ page }) => {
      await page.goto("/home");
      data.erinWs = await personal(erin);
      const body = { name: `${runTag} phone canvas`, description: "", enabled: true, trigger: { type: "manual" }, steps: [step2("a", "First", "one"), step2("b", "Second", "two")] };
      data.erinId = (await api(erin, "POST", "/workflows", body, data.erinWs)).body.id;
      await page.goto(`/workflows/${data.erinId}`);
      await page.locator('[data-step="1"]').tap();
      await page.getByLabel("Message").fill("two, edited on a phone");
      await page.getByRole("button", { name: "Close panel" }).tap();
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(wide <= 0, `the canvas page scrolls sideways by ${wide}px`);
      await page.getByRole("button", { name: "Save" }).tap();
      await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
      const wf = (await api(erin, "GET", `/workflows/${data.erinId}`, undefined, data.erinWs)).body;
      check(wf.steps[1].config.message === "two, edited on a phone", `stored message is "${wf.steps[1].config.message}"`);
    });
    await step(alice, "cleans up", () => cleanup(alice, runTag));
    await step(erin, "cleans up", () => cleanup(erin, runTag));
  },
};
