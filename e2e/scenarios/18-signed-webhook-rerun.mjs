import crypto from "node:crypto";
import { api, cleanup, personal } from "./kw.mjs";

const SIGNING = "whsec_scenario_3kT9vQ2m";
const retry = { max: 0, backoffSeconds: 5 };

export default {
  name: "A webhook that checks GitHub's signature refuses unsigned calls, and a past run can be run again",
  tags: ["webhooks", "security"],
  actors: ["alice", "carol"],
  expectedHttp: [401],
  async run({ actors: { alice, carol }, step, check, sees, eventually, runTag, data, note }) {
    const name = `HOOK_${runTag.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(-8)}`;
    await step(alice, "saves the signing secret and turns the signature check on in the editor", async ({ page }) => {
      await page.goto("/home");
      data.ws = await personal(alice);
      check((await api(alice, "PUT", `/secrets/${name}`, { value: SIGNING }, data.ws)).status === 200, "the secret wasn't saved");
      const wf = {
        name: `${runTag} signed`,
        description: "",
        enabled: true,
        trigger: { type: "webhook" },
        steps: [{ id: "say", name: "Say what came", type: "log", retry, config: { message: "Got {{ trigger.body.action }}" } }],
      };
      const made = (await api(alice, "POST", "/workflows", wf, data.ws)).body;
      data.id = made.id;
      await page.goto(`/workflows/${made.id}`);
      await page.getByRole("button", { name: "list", exact: true }).click();
      await page.getByLabel("Check the sender's signature").selectOption("github");
      await page.getByLabel("Signing secret").selectOption(name);
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
      const saved = (await api(alice, "GET", `/workflows/${made.id}`, undefined, data.ws)).body;
      check(saved.trigger.verify?.provider === "github" && saved.trigger.verify?.secret === name, `trigger saved as ${JSON.stringify(saved.trigger)}`);
      data.hook = `/hooks/${saved.hookKey}`;
    });
    const send = (actor, headers, body) =>
      actor.page.evaluate(
        async ({ hook, headers, body }) => {
          const res = await fetch(hook, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
          return { status: res.status, body: await res.json().catch(() => null) };
        },
        { hook: data.hook, headers, body },
      );
    const body = JSON.stringify({ action: "opened" });
    await step(carol, "knows the URL but not the secret: unsigned and wrongly signed calls start nothing", async ({ page }) => {
      await page.goto("/home");
      const unsigned = await send(carol, {}, body);
      check(unsigned.status === 401, `an unsigned call gave ${unsigned.status}, expected 401`);
      const guess = crypto.createHmac("sha256", "not-the-secret").update(body).digest("hex");
      const wrong = await send(carol, { "x-hub-signature-256": `sha256=${guess}` }, body);
      check(wrong.status === 401, `a wrongly signed call gave ${wrong.status}, expected 401`);
      const runs = (await api(alice, "GET", `/runs?workflowId=${data.id}`, undefined, data.ws)).body;
      check(runs.length === 0, `refused calls started ${runs.length} run(s)`);
    });
    await step(alice, "sends the same call signed with the secret, and it runs", async ({ page }) => {
      const good = crypto.createHmac("sha256", SIGNING).update(body).digest("hex");
      const res = await send(alice, { "x-hub-signature-256": `sha256=${good}` }, body);
      check(res.status === 202, `a correctly signed call gave ${res.status}: ${JSON.stringify(res.body)}`);
      data.run = res.body.runId;
      await page.goto(`/runs/${data.run}`);
      await sees(alice, "Got opened");
    });
    await step(alice, "runs that run again and lands on a new run with the same input", async ({ page }) => {
      await eventually(async () => page.getByRole("button", { name: "Run again" }).isVisible(), { message: "no Run again button on a finished run" });
      await page.getByRole("button", { name: "Run again" }).click();
      await page.waitForURL((url) => /\/runs\/run_/.test(url.pathname) && !url.pathname.endsWith(data.run), { timeout: 15000 });
      await sees(alice, "again from");
      await sees(alice, "Got opened");
      const again = (await api(alice, "GET", `/runs/${page.url().split("/").pop()}`, undefined, data.ws)).body;
      check(again.rerunOf === data.run && again.triggerType === "webhook", `the new run: rerunOf ${again.rerunOf}, trigger ${again.triggerType}`);
      check(JSON.stringify(again.input.body) === body, "the new run's input differs from the first run's");
      note("Signed webhook accepted, unsigned refused, and the run was repeated from its page.");
      await api(alice, "DELETE", `/secrets/${name}`, undefined, data.ws);
      await cleanup(alice, runTag);
    });
  },
};
