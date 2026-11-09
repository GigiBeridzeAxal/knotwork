export default {
  name: "The front page leads to Log in, Sign up and the demo; a signed-in user goes straight to the app",
  tags: ["outside", "sessions"],
  actors: ["dave", "alice"],
  expectedHttp: [401],
  async run({ actors: { dave, alice }, step, check }) {
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
    await step(alice, "already signed in, clicks Sign up and lands in the app, not on a form", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("link", { name: "Sign up", exact: true }).click();
      await page.waitForURL(/\/home$/);
      check((await page.getByRole("button", { name: "Create account" }).count()) === 0, "sign-up form shown to a signed-in user");
    });
  },
};
