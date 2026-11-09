import { api, cleanup, personal } from "./kw.mjs";

const retry = { max: 0, backoffSeconds: 5 };
const workflow = (name) => ({
  name,
  description: "",
  enabled: true,
  trigger: { type: "manual" },
  steps: [
    { id: "shape", name: "Shape it", type: "transform", retry, config: { output: { text: "Order {{ trigger.body.id }}" } } },
    { id: "say", name: "Say it", type: "log", retry, config: { message: "{{ steps.shape.text }}" } },
  ],
});

export default {
  name: "Version history restores an older save; one step is tested without a run; strangers see neither",
  tags: ["history", "isolation"],
  actors: ["alice", "carol"],
  expectedHttp: [404],
  async run({ actors: { alice, carol }, step, check, eventually, runTag, data }) {
    await step(alice, "creates a workflow, then renames it and removes a step in the editor", async ({ page }) => {
      await page.goto("/home");
      data.ws = await personal(alice);
      data.id = (await api(alice, "POST", "/workflows", workflow(`${runTag} v1 name`), data.ws)).body.id;
      await page.goto(`/workflows/${data.id}`);
      await page.locator('[data-step="1"]').click();
      await page.getByRole("button", { name: "Remove step" }).click();
      await page.locator("#wf-name").fill(`${runTag} v2 name`);
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    });
    await step(alice, "opens History, looks at version 1 on the canvas, and nothing has changed yet", async ({ page }) => {
      await page.getByRole("tab", { name: "History" }).click();
      await page.getByRole("button", { name: /^Version 2, current/ }).waitFor();
      await page.getByRole("button", { name: /^Version 1:/ }).click();
      await page.getByText("Version 1", { exact: true }).waitFor();
      check((await page.locator("[data-step]").count()) === 2, "the preview of version 1 doesn't show its two steps");
      check((await page.locator("#wf-name").inputValue()) === `${runTag} v2 name`, "looking at a version changed the draft");
      const stored = (await api(alice, "GET", `/workflows/${data.id}`, undefined, data.ws)).body;
      check(stored.version === 2 && stored.steps.length === 1, "looking at a version changed the stored workflow");
    });
    await step(alice, "restores version 1 and saves: it becomes version 3, and 1 and 2 are still listed", async ({ page }) => {
      await page.getByRole("button", { name: "Restore this version" }).click();
      check((await page.locator("#wf-name").inputValue()) === `${runTag} v1 name`, "restoring didn't bring the old name back");
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
      const stored = (await api(alice, "GET", `/workflows/${data.id}`, undefined, data.ws)).body;
      check(stored.version === 3 && stored.steps.length === 2 && stored.name === `${runTag} v1 name`, `stored: v${stored.version}, ${stored.steps.length} steps, "${stored.name}"`);
      const versions = (await api(alice, "GET", `/workflows/${data.id}/versions`, undefined, data.ws)).body;
      check(versions.map((v) => v.version).join() === "3,2,1", `versions listed: ${versions.map((v) => v.version).join()}`);
    });
    await step(alice, "tests the first step by itself: it passes, and no run was started", async ({ page }) => {
      await page.locator('[data-step="0"]').click();
      await page.getByRole("tab", { name: "Test" }).click();
      await page.getByLabel("Test data").fill('{ "trigger": { "body": { "id": "order_7" } }, "steps": {} }');
      await page.getByRole("button", { name: "Test this step" }).click();
      await page.locator('[data-test-result="ok"]').waitFor();
      await page.getByText('"Order order_7"').first().waitFor();
      await eventually(async () => (await page.getByLabel("Test data").inputValue()).includes('"shape"'), { message: "the step's output wasn't added to the test data" });
      const runs = (await api(alice, "GET", `/runs?workflowId=${data.id}`, undefined, data.ws)).body;
      check(runs.length === 0, `testing a step started ${runs.length} run(s)`);
    });
    await step(alice, "tests the second step with that output", async ({ page }) => {
      await page.locator('[data-step="1"]').click();
      await page.getByRole("button", { name: "Test this step" }).click();
      await page.locator('[data-test-result="ok"]').waitFor();
      await page.getByText("Order order_7").first().waitFor();
    });
    await step(carol, "asks for alice's versions and sample data, with her own workspace and with alice's: refused", async ({ page }) => {
      await page.goto("/home");
      const own = await personal(carol);
      for (const ws of [own, data.ws]) {
        for (const path of [`/workflows/${data.id}/versions`, `/workflows/${data.id}/versions/1`, `/workflows/${data.id}/sample`]) {
          const res = await api(carol, "GET", path, undefined, ws);
          check(res.status === 404, `GET ${path} gave carol ${res.status}, expected 404`);
        }
      }
    });
    await step(alice, "deletes the workflow, and its versions go with it", async () => {
      await cleanup(alice, runTag);
      const res = await api(alice, "GET", `/workflows/${data.id}/versions`, undefined, data.ws);
      check(res.status === 404, `versions of a deleted workflow gave ${res.status}`);
    });
  },
};
