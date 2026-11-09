import { api, cleanup } from "./kw.mjs";

export default {
  name: "On a phone: the drawer shows Personal and the + box, and a workflow runs",
  tags: ["mobile"],
  actors: ["erin"],
  async run({ actors: { erin }, step, check, eventually, sees, runTag }) {
    await step(erin, "opens the drawer and uses the + box", async ({ page }) => {
      await page.goto("/home");
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.getByRole("dialog", { name: "Menu" }).getByRole("link", { name: /New workflow in Personal/ }).click();
      await page.locator("#wf-name").fill(`${runTag} phone`);
      await page.getByRole("button", { name: "Create" }).click();
      await page.waitForURL(/\/workflows\/wf_/);
    });
    await step(erin, "has no sideways scroll", async ({ page }) => {
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(wide <= 0, `page scrolls sideways by ${wide}px`);
    });
    await step(erin, "runs it and sees it pass", async ({ page }) => {
      await page.getByRole("button", { name: "Run now" }).click();
      await page.getByRole("button", { name: /^Run$|Start run|Run it/ }).last().click().catch(() => {});
      await page.waitForURL(/\/runs\//, { timeout: 15000 });
      await eventually(async () => page.getByText("Passed").count(), { timeout: 15000 });
      await cleanup(erin, runTag);
    });
  },
};
