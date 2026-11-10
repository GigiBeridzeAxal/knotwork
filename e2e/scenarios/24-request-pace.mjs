import { api, cleanup, logWorkflow, personal } from "./kw.mjs";

// Cloudflare blocks an address that sends more than 10 requests to /api/ in 10 seconds. The app
// paces itself under that (src/pace.ts) and, when it is refused anyway (a second tab, an office
// behind one address), waits and sends the request again instead of showing "429".
export default {
  name: "Clicking through the app quickly stays under the request limit, and a 429 heals by itself",
  tags: ["limits", "resilience"],
  actors: ["alice"],
  expectedHttp: [429],
  async run({ actors: { alice }, step, check, runTag, data }) {
    await step(alice, "has a workflow, and turns request pacing on (it is off on localhost)", async ({ page }) => {
      await page.goto("/home");
      data.ws = await personal(alice);
      const made = await api(alice, "POST", "/workflows", logWorkflow(`${runTag} pace`), data.ws);
      check(made.status === 201, `create gave ${made.status}`);
      data.id = made.body.id;
      await page.evaluate(() => {
        localStorage.setItem("knotwork.pace", "on");
        sessionStorage.removeItem("knotwork.sent");
      });
    });
    await step(alice, "opens page after page without a pause, twice over", async ({ page }) => {
      const sent = [];
      const count = (r) => new URL(r.url()).pathname.startsWith("/api/") && sent.push(Date.now());
      page.on("request", count);
      await page.goto("/home");
      for (let round = 0; round < 2; round++) {
        for (const path of ["/workflows", `/workflows/${data.id}`, "/runs", "/settings", "/templates", "/home"]) {
          await page.evaluate((to) => {
            history.pushState(null, "", to);
            dispatchEvent(new PopStateEvent("popstate"));
          }, path);
          await page.waitForTimeout(250);
        }
      }
      // Everything that had to wait for its turn has been sent by now.
      await page.waitForTimeout(12_000);
      page.off("request", count);
      const worst = Math.max(...sent.map((a) => sent.filter((b) => b >= a && b < a + 10_000).length));
      check(sent.length >= 10, `only ${sent.length} requests were sent, so this proves nothing`);
      check(worst <= 9, `${worst} requests went out within 10 seconds (the limit is 10)`);
      await page.getByText("FREE PLAN").first().waitFor();
      check((await page.getByText(/Request failed|429/).count()) === 0, "the page shows a request error");
    });
    await step(alice, "is refused once by Cloudflare, sees a short notice, and the page loads by itself", async ({ page }) => {
      let refused = 0;
      await page.route(`**/api/workflows/${data.id}`, (route) =>
        refused++ === 0
          ? route.fulfill({ status: 429, contentType: "text/plain", headers: { "retry-after": "3" }, body: "error code: 1015" })
          : route.continue(),
      );
      await page.evaluate((to) => {
        history.pushState(null, "", to);
        dispatchEvent(new PopStateEvent("popstate"));
      }, `/workflows/${data.id}`);
      await page.getByText("Too many requests at once").waitFor({ timeout: 5000 });
      await page.locator("#wf-name").waitFor({ timeout: 15_000 });
      await page.getByText("Too many requests at once").waitFor({ state: "hidden", timeout: 5000 });
      check(refused >= 2, "the refused request wasn't sent again");
      check((await page.getByText(/Request failed|429/).count()) === 0, "the page shows a request error");
      await page.unroute(`**/api/workflows/${data.id}`);
    });
    await step(alice, "turns pacing off again and cleans up", async ({ page }) => {
      await page.evaluate(() => localStorage.removeItem("knotwork.pace"));
      await cleanup(alice, runTag);
    });
  },
};
