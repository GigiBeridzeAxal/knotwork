export default {
  name: "A visitor signs up, logs out, and logs back in",
  tags: ["sessions", "outside"],
  actors: ["dave"],
  expectedHttp: [400, 401],
  async run({ actors: { dave }, step, check, sees, runTag, data }) {
    data.email = `dave.${runTag.replace(/[^a-z0-9]/gi, "").slice(-4)}.${Date.now()}@example.com`.toLowerCase();
    data.password = `pw-${Math.random().toString(36).slice(2)}-long`;
    await step(dave, "opens the app while logged out and lands on the login page", async ({ page }) => {
      await page.goto("/workflows");
      await page.waitForURL(/\/login\?next=/);
      await page.getByRole("heading", { name: "Log in" }).waitFor();
    });
    await step(dave, "tries to sign up with a short password and sees why it's refused", async ({ page }) => {
      await page.getByRole("link", { name: "Create an account" }).click();
      await page.getByLabel("Name").fill("Dave Visitor");
      await page.getByLabel("Email").fill(data.email);
      await page.getByLabel("Password").fill("short");
      await page.getByRole("button", { name: "Create account" }).click();
      await sees(dave, "Use at least 10 characters");
    });
    await step(dave, "signs up and gets a Personal workspace, then lands where he was going", async ({ page }) => {
      await page.getByLabel("Password").fill(data.password);
      await page.getByRole("button", { name: "Create account" }).click();
      await page.waitForURL(/\/workflows$/);
      await page.getByRole("button", { name: /Personal/ }).first().waitFor();
    });
    await step(dave, "logs out from the account menu and can't open the app any more", async ({ page }) => {
      await page.getByRole("button", { name: "Account menu" }).click();
      await page.getByRole("menuitem", { name: "Log out" }).click();
      await page.waitForURL(/\/login/);
      const res = await page.evaluate(async () => (await fetch("/api/me")).status);
      check(res === 401, `/api/me after logout gave ${res}`);
      await page.goto("/home");
      await page.waitForURL(/\/login/);
    });
    await step(dave, "gets a clear error for a wrong password", async ({ page }) => {
      await page.getByLabel("Email").fill(data.email);
      await page.getByLabel("Password").fill("not the password");
      await page.getByRole("button", { name: "Log in" }).click();
      await sees(dave, "don't match an account");
    });
    await step(dave, "logs in with the right password and is back home", async ({ page }) => {
      await page.getByLabel("Password").fill(data.password);
      await page.getByRole("button", { name: "Log in" }).click();
      await page.waitForURL(/\/home$/);
      await page.getByRole("button", { name: "Account menu" }).click();
      await sees(dave, data.email);
    });
  },
};
