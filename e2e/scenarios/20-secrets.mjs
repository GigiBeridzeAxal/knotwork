import { api, cleanup, personal } from "./kw.mjs";

const VALUE = "tok_live_9f3KqT7zR2";
const retry = { max: 0, backoffSeconds: 5 };

export default {
  name: "A secret is saved once, used by a run, hidden in its log, and invisible to other accounts",
  tags: ["secrets", "isolation"],
  actors: ["alice", "carol"],
  expectedHttp: [404],
  async run({ actors: { alice, carol }, step, check, sees, doesNotSee, eventually, runTag, data }) {
    const name = `TOKEN_${runTag.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(-8)}`;
    await step(alice, "adds a secret in Settings", async ({ page }) => {
      await page.goto("/settings");
      data.ws = await personal(alice);
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.getByLabel("Value", { exact: true }).fill(VALUE);
      await page.getByRole("button", { name: "Add secret" }).click();
      await sees(alice, `${name} is saved`);
      await sees(alice, page.getByRole("list", { name: "Secrets" }).getByText(name, { exact: true }));
    });
    await step(alice, "can't read the value back: not on the page, not from the API", async ({ page }) => {
      await page.reload();
      await sees(alice, page.getByRole("list", { name: "Secrets" }).getByText(name, { exact: true }));
      const html = await page.content();
      check(!html.includes(VALUE), "the secret's value is in the Settings page");
      const list = await api(alice, "GET", "/secrets", undefined, data.ws);
      check(list.status === 200 && list.body.some((s) => s.name === name), "the secret isn't listed");
      check(!JSON.stringify(list.body).includes(VALUE), "the API sent the secret's value back");
    });
    await step(alice, "runs a workflow that uses it, and the log hides the value", async ({ page }) => {
      const wf = {
        name: `${runTag} uses a secret`,
        description: "",
        enabled: true,
        trigger: { type: "manual" },
        steps: [
          { id: "shape", name: "Build a header", type: "transform", retry, config: { output: { authorization: `Bearer {{ secrets.${name} }}` } } },
          { id: "say", name: "Say it", type: "log", retry, config: { message: `The header is {{ steps.shape.authorization }}` } },
        ],
      };
      data.id = (await api(alice, "POST", "/workflows", wf, data.ws)).body.id;
      const { runId } = (await api(alice, "POST", `/workflows/${data.id}/run`, { input: {} }, data.ws)).body;
      await page.goto(`/runs/${runId}`);
      await sees(alice, `The header is Bearer [secret ${name}]`);
      const run = (await api(alice, "GET", `/runs/${runId}`, undefined, data.ws)).body;
      check(run.status === "succeeded", `the run ended ${run.status}: ${run.error}`);
      check(!JSON.stringify(run).includes(VALUE), "the run's log holds the secret's value");
    });
    await step(alice, "sees the secret offered in the editor's list of what a step can use", async ({ page }) => {
      await page.goto(`/workflows/${data.id}`);
      await page.getByRole("button", { name: /Say it/ }).click();
      await sees(alice, `{{ secrets.${name} }}`);
    });
    await step(carol, "sees none of alice's secrets and can't touch them through the API", async ({ page }) => {
      await page.goto("/settings");
      await page.getByLabel("Name", { exact: true }).waitFor();
      await doesNotSee(carol, name);
      for (const [m, p, body] of [
        ["GET", "/secrets"],
        ["PUT", `/secrets/${name}`, { value: "carols-own-value" }],
        ["DELETE", `/secrets/${name}`],
      ]) {
        const res = await api(carol, m, p, body, data.ws);
        check(res.status === 404, `${m} ${p} with alice's workspace gave ${res.status}, expected 404`);
      }
    });
    await step(alice, "deletes the secret, and the next run fails saying which secret is missing", async ({ page }) => {
      await page.goto("/settings");
      await page.getByRole("button", { name: `Delete ${name}` }).click();
      await eventually(async () => (await page.getByRole("list", { name: "Secrets" }).getByText(name, { exact: true }).count()) === 0, {
        message: "the deleted secret is still listed",
      });
      const { runId } = (await api(alice, "POST", `/workflows/${data.id}/run`, { input: {} }, data.ws)).body;
      await page.goto(`/runs/${runId}`);
      await sees(alice, `The secret ${name} isn't set in this workspace`);
      await cleanup(alice, runTag);
    });
  },
};
