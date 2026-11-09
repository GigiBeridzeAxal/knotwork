export default {
  name: "The front page leads to Log in, Sign up and the demo; a signed-in user goes straight to the app",
  tags: ["outside", "sessions"],
  actors: ["dave", "alice", "carol"],
  expectedHttp: [401],
  async run({ actors: { dave, alice, carol }, step, check, sees, runTag, data }) {
    await step(dave, "sees Log in in the top bar and it opens the login form", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("link", { name: "Log in", exact: true }).click();
      await page.waitForURL(/\/login$/);
      await page.getByRole("heading", { name: "Log in" }).waitFor();
      await page.getByRole("button", { name: "Try the demo account" }).waitFor();
    });
    await step(dave, "uses Sign up in the top bar and gets the create-account form", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("link", { name: "Sign up", exact: true }).click();
      await page.waitForURL(/\/signup$/);
      await page.getByRole("button", { name: "Create account" }).waitFor();
    });
    await step(dave, "uses 'Build a workflow, free' and also gets sign-up", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("link", { name: /Build a workflow, free/ }).click();
      await page.waitForURL(/\/signup$/);
    });
    await step(dave, "follows 'try the demo account' and opens the demo in one click", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("link", { name: "try the demo account" }).click();
      await page.waitForURL(/\/login$/);
      await page.getByRole("button", { name: "Try the demo account" }).click();
      await page.waitForURL(/\/home$/);
      await page.getByRole("button", { name: /Personal/ }).first().waitFor();
    });
    await step(dave, "still in the demo, uses Sign up on the front page and gets the form, not the demo", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("link", { name: "Sign up", exact: true }).click();
      await page.waitForURL(/\/signup$/);
      await page.getByRole("button", { name: "Create account" }).waitFor();
    });
    await step(dave, "creates an account from there and lands in a Personal workspace of his own", async ({ page }) => {
      data.email = `dave.${runTag.replace(/[^a-z0-9]/gi, "").slice(-4)}.${Date.now()}@example.com`.toLowerCase();
      await page.getByLabel("Name").fill("Dave FromDemo");
      await page.getByLabel("Email").fill(data.email);
      await page.getByLabel("Password").fill(`pw-${Math.random().toString(36).slice(2)}-long`);
      await page.getByRole("button", { name: "Create account" }).click();
      await page.waitForURL(/\/home$/);
      await page.getByRole("button", { name: "Account menu" }).click();
      await sees(dave, data.email);
      const who = await page.evaluate(async () => (await (await fetch("/api/me")).json()).user);
      check(who.demo === false && who.email === data.email, `signed in as ${JSON.stringify(who)}`);
    });
    await step(carol, "in the demo, finds 'Create your own account' in the account menu", async ({ page }) => {
      // carol has her own account; open the demo over it, as the demo button would.
      await page.goto("/home");
      await page.evaluate(() => fetch("/api/auth/demo", { method: "POST" }));
      await page.goto("/home");
      await page.getByRole("button", { name: "Account menu" }).click();
      await page.getByRole("menuitem", { name: "Create your own account" }).click();
      await page.waitForURL(/\/signup$/);
      await page.getByRole("button", { name: "Create account" }).waitFor();
    });
    await step(alice, "already signed in, clicks Sign up and lands in the app, not on a form", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("link", { name: "Sign up", exact: true }).click();
      await page.waitForURL(/\/home$/);
      check((await page.getByRole("button", { name: "Create account" }).count()) === 0, "sign-up form shown to a signed-in user");
    });
  },
};
