import { api, personal, logWorkflow } from "./kw.mjs";

export default [
  {
    name: "Changing the password logs out other devices; deleting the account removes it",
    tags: ["sessions", "lifecycle"],
    actors: ["dave", "carol"],
    expectedHttp: [401, 403],
    async run({ actors: { dave, carol }, step, check, sees, runTag, data }) {
      data.email = `dave.pw.${runTag.replace(/[^a-z0-9]/gi, "").slice(-4)}.${Date.now()}@example.com`.toLowerCase();
      data.password = `pw-${Math.random().toString(36).slice(2)}-long`;
      data.next = `new-${Math.random().toString(36).slice(2)}-long`;
      await step(dave, "signs up", async ({ page }) => {
        await page.goto("/signup");
        await page.getByLabel("Name").fill("Dave Mover");
        await page.getByLabel("Email").fill(data.email);
        await page.getByLabel("Password").fill(data.password);
        await page.getByRole("button", { name: "Create account" }).click();
        await page.waitForURL(/\/home$/);
      });
      // carol's browser stands in for dave's second device.
      await step(carol, "logs in to dave's account on a second device", async ({ page }) => {
        await page.context().clearCookies();
        await page.goto("/login");
        await page.getByLabel("Email").fill(data.email);
        await page.getByLabel("Password").fill(data.password);
        await page.getByRole("button", { name: "Log in" }).click();
        await page.waitForURL(/\/home$/);
      });
      await step(dave, "is refused with a wrong current password", async ({ page }) => {
        await page.goto("/settings");
        await page.getByLabel("Current password").fill("not my password");
        await page.getByLabel("New password").fill(data.next);
        await page.getByRole("button", { name: "Change password" }).click();
        await sees(dave, "isn't your current password");
      });
      await step(dave, "changes the password in Settings", async ({ page }) => {
        await page.getByLabel("Current password").fill(data.password);
        await page.getByLabel("New password").fill(data.next);
        await page.getByRole("button", { name: "Change password" }).click();
        await sees(dave, "Other devices were logged out");
        const res = await page.evaluate(async () => (await fetch("/api/me")).status);
        check(res === 200, `dave's own session after the change gave ${res}`);
      });
      await step(carol, "the second device is logged out on its next request", async ({ page }) => {
        const res = await page.evaluate(async () => (await fetch("/api/me")).status);
        check(res === 401, `second device /api/me gave ${res}`);
      });
      await step(dave, "deletes the account with his password and lands on the login page", async ({ page }) => {
        await page.getByLabel("Your password").fill(data.next);
        await page.getByRole("button", { name: "Delete account" }).click();
        await page.waitForURL(/\/login/);
      });
      await step(dave, "can't log in any more", async ({ page }) => {
        await page.getByLabel("Email").fill(data.email);
        await page.getByLabel("Password").fill(data.next);
        await page.getByRole("button", { name: "Log in" }).click();
        await sees(dave, "don't match an account");
      });
    },
  },
  {
    name: "A link to a workflow in another workspace switches to that workspace",
    tags: ["workspaces"],
    actors: ["alice", "carol"],
    expectedHttp: [404],
    async run({ actors: { alice, carol }, step, check, sees, runTag, data, leftBehind }) {
      await step(alice, "has a workflow in a second workspace (set up through the API)", async ({ page }) => {
        await page.goto("/home");
        const ws = await api(alice, "POST", "/workspaces", { name: `Side ${runTag.slice(-5, -1)}` });
        check(ws.status === 201, `create workspace gave ${ws.status}`);
        data.ws = ws.body;
        const wf = await api(alice, "POST", "/workflows", logWorkflow(`${runTag} elsewhere`), data.ws.id);
        check(wf.status === 201, `create workflow gave ${wf.status}`);
        data.wf = wf.body;
        data.cleaned = leftBehind(`workspace ${data.ws.name} of alice`);
      });
      await step(alice, "opens the link while Personal is selected and lands in the right workspace", async ({ page }) => {
        await page.goto(`/workflows/${data.wf.id}`);
        await page.getByLabel("Workflow name").and(page.locator(`[value="${runTag} elsewhere"]`)).waitFor();
        await page.getByRole("button", { name: new RegExp(`Side ${runTag.slice(-5, -1)}`) }).first().waitFor();
      });
      await step(carol, "opening the same link in another account still says it doesn't exist", async ({ page }) => {
        await page.goto(`/workflows/${data.wf.id}`);
        await sees(carol, "No workflow with that id");
      });
      await step(alice, "cleans up", async () => {
        const del = await api(alice, "DELETE", `/workspaces/${data.ws.id}`);
        check(del.status === 204, `delete workspace gave ${del.status}`);
        data.cleaned();
      });
    },
  },
];
