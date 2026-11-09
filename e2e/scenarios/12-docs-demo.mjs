import { api } from "./kw.mjs";

export default {
  name: "The user guide is public, and /demo opens the demo in one click without swapping a signed-in account",
  tags: ["outside", "demo", "docs"],
  actors: ["dave", "alice"],
  expectedHttp: [401],
  async run({ actors: { dave, alice }, step, check, sees }) {
    await step(dave, "opens /docs while logged out and reads the guide", async ({ page }) => {
      await page.context().clearCookies();
      await page.goto("/docs");
      await page.getByRole("heading", { name: "How to use Knotwork" }).waitFor();
      await sees(dave, "Templates");
      check(!/\/login/.test(page.url()), `docs sent a visitor to ${page.url()}`);
    });
    await step(dave, "presses Try the demo and lands on the demo's home page", async ({ page }) => {
      await page.getByRole("link", { name: "Try the demo" }).click();
      await page.waitForURL(/\/home$/, { timeout: 20000 });
      await sees(dave, "Watch a GitHub repo");
      const me = await api(dave, "GET", "/me");
      check(me.body?.user?.demo === true, "the /demo link did not sign in to the demo account");
    });
    await step(alice, "already signed in, opens /demo and stays herself", async ({ page }) => {
      await page.goto("/demo");
      await page.waitForURL(/\/home$/, { timeout: 20000 });
      const me = await api(alice, "GET", "/me");
      check(me.body?.user?.demo === false, "/demo replaced a signed-in account with the demo");
    });
    await step(alice, "finds Docs in the sidebar", async ({ page }) => {
      await page.getByRole("link", { name: "Docs", exact: true }).first().click();
      await page.waitForURL(/\/docs$/);
      await page.getByRole("link", { name: "Open Knotwork" }).waitFor();
    });
  },
};
