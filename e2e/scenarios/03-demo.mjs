import { api } from "./kw.mjs";

export default {
  name: "Two visitors open the shared demo account with one click",
  tags: ["demo", "sharing"],
  actors: ["dave", "carol"],
  async run({ actors: { dave, carol }, step, together, check, eventually, sees, runTag, data }) {
    // carol is signed in already; she logs out first so both are visitors.
    await step(carol, "logs out", async ({ page }) => {
      await page.goto("/home");
      // Drop the cookie instead of logging out, so carol's saved session keeps working for other scenarios.
      await page.context().clearCookies();
      await page.goto("/login");
    });
    await step(dave, "opens the login page", ({ page }) => page.goto("/login"));
    await together(
      step(dave, "clicks Try the demo account", async ({ page }) => {
        await page.getByRole("button", { name: "Try the demo account" }).click();
        await page.waitForURL(/\/home$/);
      }),
      step(carol, "clicks Try the demo account", async ({ page }) => {
        await page.getByRole("button", { name: "Try the demo account" }).click();
        await page.waitForURL(/\/home$/);
      }),
    );
    await step(dave, "sees the example workflows and that the account is shared", async ({ page }) => {
      await sees(dave, "Watch a GitHub repo");
      await page.getByRole("button", { name: "Account menu" }).click();
      await sees(dave, "resets every day");
    });
    await step(dave, "adds a workflow in the demo", async () => {
      const ws = (await api(dave, "GET", "/me")).body.workspaces[0].id;
      data.ws = ws;
      const res = await api(dave, "POST", "/workflows", { name: `${runTag} demo note`, description: "", enabled: true, trigger: { type: "manual" }, steps: [] }, ws);
      check(res.status === 201, `create in demo gave ${res.status}`);
      data.id = res.body.id;
    });
    await step(carol, "sees dave's workflow in the same demo account", () =>
      eventually(async () => {
        await carol.page.reload();
        await carol.page.getByText("Watch a GitHub repo").first().waitFor();
        return carol.page.getByText(`${runTag} demo note`).count();
      }, { timeout: 15000 }),
    );
    await step(dave, "removes it again", () => api(dave, "DELETE", `/workflows/${data.id}`, undefined, data.ws));
  },
};
