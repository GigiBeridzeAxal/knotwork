import { api, keyApi, sideways, switcher } from "./kw.mjs";

export default {
  name: "On a phone: join from an invite link; Members, API keys and Recovery fit the screen",
  tags: ["mobile", "sharing"],
  actors: ["alice", "erin"],
  expectedHttp: [401],
  async run({ actors: { alice, erin }, step, check, sees, baseURL, runTag, data, leftBehind }) {
    const wsName = `Phone ${runTag.slice(-5, -1)}`;

    await step(alice, "has a workspace and an editor invite link (set up through the API)", async ({ page }) => {
      await page.goto("/home");
      const ws = await api(alice, "POST", "/workspaces", { name: wsName });
      check(ws.status === 201, `create workspace gave ${ws.status}`);
      data.ws = ws.body.id;
      data.cleaned = leftBehind(`workspace "${wsName}" (${data.ws}) of alice`);
      const invite = await api(alice, "POST", `/workspaces/${data.ws}/invites`, { role: "editor" });
      check(invite.status === 201 && invite.body.token, `create invite gave ${invite.status}`);
      data.token = invite.body.token;
    });

    await step(erin, "opens the link on her phone and joins with a tap", async ({ page }) => {
      await page.goto(`/join/${data.token}`);
      await page.getByRole("heading", { name: new RegExp(`invited you to ${wsName}`) }).waitFor();
      const wide = await sideways(page);
      check(wide <= 0, `the join page scrolls sideways by ${wide}px`);
      await page.getByRole("button", { name: "Join workspace" }).tap();
      await page.waitForURL(/\/home$/);
      await (await switcher(erin)).filter({ hasText: wsName }).waitFor();
      await page.getByRole("button", { name: "Close menu" }).last().tap();
    });

    await step(erin, "Settings has no sideways scroll, with the Members, API keys and Recovery codes sections", async ({ page }) => {
      await page.goto("/settings");
      for (const title of ["Recovery codes", "Members", "API keys"]) {
        const heading = page.getByRole("heading", { name: title, exact: true });
        await heading.scrollIntoViewIfNeeded();
        await heading.waitFor();
      }
      await page.getByRole("list", { name: "Members" }).waitFor();
      await sees(erin, "You're an editor here");
      const wide = await sideways(page);
      check(wide <= 0, `Settings scrolls sideways by ${wide}px`);
      const out = await page.evaluate(() =>
        [...document.querySelectorAll("main section")].filter((s) => s.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map((s) => s.querySelector("h2")?.textContent),
      );
      check(out.length === 0, `sections wider than the screen: ${out.join(", ")}`);
    });

    await step(erin, "makes a read key; the one-time key panel fits too, and the key works", async ({ page }) => {
      await page.getByLabel("Key name").fill(`${runTag} phone`);
      await page.getByLabel("Access").selectOption("read");
      await page.getByRole("button", { name: "Create API key" }).tap();
      const key = await page.getByLabel("Your new API key").inputValue();
      const wide = await sideways(page);
      check(wide <= 0, `the key panel makes Settings scroll sideways by ${wide}px`);
      const box = await page.getByRole("button", { name: "Copy", exact: true }).boundingBox();
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      check(box && box.x + box.width <= vw, "the Copy button is off screen");
      const res = await keyApi(baseURL, key, "GET", "/workflows");
      check(res.status === 200, `erin's key gave ${res.status}`);
      data.key = key;
      await page.getByRole("button", { name: "Done, hide it" }).tap();
    });

    await step(erin, "leaves the workspace; her key for it stops working", async ({ page }) => {
      await page.getByRole("button", { name: "Leave workspace" }).tap();
      await page.waitForURL(/\/home$/);
      const res = await keyApi(baseURL, data.key, "GET", "/workflows");
      check(res.status === 401, `a key for a workspace erin left gave ${res.status}`);
    });

    await step(alice, "deletes the workspace (cleanup)", async ({ page }) => {
      if (!data.ws) return;
      if (!page.url().startsWith("http")) await page.goto("/home");
      const del = await api(alice, "DELETE", `/workspaces/${data.ws}`);
      check(del.status === 204, `delete workspace gave ${del.status}`);
      data.cleaned();
    }, { soft: true });
  },
};
