import { api, cleanup, logWorkflow, personal } from "./kw.mjs";

export default {
  name: "A stranger can't see or change another account's workflows",
  tags: ["isolation"],
  actors: ["alice", "carol"],
  expectedHttp: [404],
  async run({ actors: { alice, carol }, step, check, sees, doesNotSee, runTag, data }) {
    await step(alice, "creates a workflow in her Personal workspace", async () => {
      await alice.page.goto("/home");
      data.ws = await personal(alice);
      data.id = (await api(alice, "POST", "/workflows", logWorkflow(`${runTag} private`), data.ws)).body.id;
      await alice.page.reload();
      await sees(alice, `${runTag} private`);
    });
    await step(carol, "doesn't see it in her sidebar or home", async () => {
      await carol.page.goto("/home");
      await carol.page.getByRole("button", { name: /Personal/ }).first().waitFor();
      await doesNotSee(carol, `${runTag} private`);
    });
    await step(carol, "opens alice's workflow URL directly and gets nothing", async () => {
      await carol.page.goto(`/workflows/${data.id}`);
      await carol.page.getByText(/No workflow with that id/).waitFor();
      await doesNotSee(carol, `${runTag} private`);
    });
    await step(carol, "calls the API with alice's workspace id: refused for read, edit, run and delete", async () => {
      for (const [m, p, body] of [
        ["GET", "/workflows"],
        ["GET", `/workflows/${data.id}`],
        ["PUT", `/workflows/${data.id}`, { ...logWorkflow("hijacked"), version: 1 }],
        ["POST", `/workflows/${data.id}/run`, {}],
        ["DELETE", `/workflows/${data.id}`],
        ["GET", "/runs"],
      ]) {
        const res = await api(carol, m, p, body, data.ws);
        check(res.status === 404, `${m} ${p} with alice's workspace gave ${res.status}, expected 404`);
      }
      const renamed = await api(carol, "PATCH", `/workspaces/${data.ws}`, { name: "hijacked" });
      check(renamed.status === 404, `renaming alice's workspace gave ${renamed.status}`);
    });
    await step(alice, "still has the workflow, unchanged", async () => {
      const wf = (await api(alice, "GET", `/workflows/${data.id}`, undefined, data.ws)).body;
      check(wf?.name === `${runTag} private` && wf.version === 1, `alice's workflow changed: ${JSON.stringify(wf?.name)} v${wf?.version}`);
      await cleanup(alice, runTag);
    });
  },
};
