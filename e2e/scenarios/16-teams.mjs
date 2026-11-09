import { api, logWorkflow, me, switcher, switchTo, switcherEntries } from "./kw.mjs";

export default {
  name: "Teams: invite link, editor and viewer, removal",
  tags: ["sharing", "roles", "isolation", "lifecycle"],
  actors: ["alice", "bob", "carol", "frank"],
  expectedHttp: [403, 404],
  async run({ actors: { alice, bob, carol, frank }, step, check, eventually, sees, doesNotSee, runTag, data, leftBehind }) {
    const wsName = `Team ${runTag.slice(-5, -1)}`;
    const flow = `${runTag} bob flow`;

    await step(alice, "has a new workspace (set up through the API) and picks it in the switcher", async ({ page }) => {
      await page.goto("/home");
      const ws = await api(alice, "POST", "/workspaces", { name: wsName });
      check(ws.status === 201, `create workspace gave ${ws.status}`);
      data.ws = ws.body.id;
      data.cleaned = leftBehind(`workspace "${wsName}" (${data.ws}) of alice`);
      const hook = await api(alice, "POST", "/workflows", { ...logWorkflow(`${runTag} hook flow`), trigger: { type: "webhook" } }, data.ws);
      check(hook.status === 201 && hook.body.hookKey, `create webhook workflow gave ${hook.status}`);
      data.hook = hook.body;
      data.alice = (await me(alice)).user;
      data.bob = (await me(bob)).user;
      data.carol = (await me(carol)).user;
      await switchTo(alice, wsName);
    });

    await step(alice, "makes an editor invite link in Settings and copies it from the field", async ({ page }) => {
      await page.goto("/settings");
      await page.getByLabel("Role", { exact: true }).selectOption("editor");
      await page.getByRole("button", { name: "Create invite link" }).click();
      data.editorLink = await page.getByLabel("Invite link", { exact: true }).inputValue();
      check(/\/join\/[A-Za-z0-9_-]{43}$/.test(data.editorLink), `invite link looks wrong: ${data.editorLink.replace(/[A-Za-z0-9_-]{43}$/, "<token>")}`);
      await sees(alice, "Invite link for editors");
    });

    await step(bob, "opens the link, sees who invited him to what, and joins", async ({ page }) => {
      await page.goto(new URL(data.editorLink).pathname);
      await page.getByRole("heading", { name: `${data.alice.name} invited you to ${wsName}` }).waitFor();
      await sees(bob, "You'd join as an editor.");
      await page.getByRole("button", { name: "Join workspace" }).click();
      await page.waitForURL(/\/home$/);
      const entries = await switcherEntries(bob);
      check(entries.some((e) => e.includes(wsName) && /Editor/i.test(e)), `bob's switcher shows ${JSON.stringify(entries)}`);
      await (await switcher(bob)).click();
      await sees(bob, page.getByRole("menu", { name: "Workspaces" }).getByText("Shared with you"));
      await page.keyboard.press("Escape");
      await (await switcher(bob)).filter({ hasText: wsName }).waitFor();
    });

    await step(bob, "creates a workflow in alice's workspace with the + box", async ({ page }) => {
      await page.getByRole("link", { name: `New workflow in ${wsName}` }).click();
      await page.locator("#wf-name").fill(flow);
      await page.getByRole("button", { name: "Create" }).click();
      await page.waitForURL(/\/workflows\/wf_/);
      data.wf = page.url().split("/workflows/")[1];
      await page.getByRole("button", { name: "Saved" }).waitFor();
    });

    await step(alice, "sees bob's workflow, and bob as an editor in Members", async ({ page }) => {
      await eventually(async () => {
        await page.goto("/workflows");
        return page.getByRole("link", { name: flow }).first().waitFor({ timeout: 4000 }).then(() => true);
      }, { timeout: 15000, message: "bob's workflow never showed up for alice" });
      await page.goto("/settings");
      await page.getByRole("list", { name: "Members" }).getByText(data.bob.name).waitFor();
      check((await page.getByLabel(`Permissions for ${data.bob.name}`).inputValue()) === "editor", "bob is not shown as editor");
    });

    await step(alice, "sees the first link listed without the link itself, and makes a viewer link", async ({ page }) => {
      const open = page.getByRole("list", { name: "Open invite links" });
      await open.getByText("1 / 10 used").waitFor();
      check(!(await page.content()).includes(new URL(data.editorLink).pathname.slice(6)), "the editor link's token is still on the page");
      await page.getByLabel("Role", { exact: true }).selectOption("viewer");
      await page.getByRole("button", { name: "Create invite link" }).click();
      data.viewerLink = await page.getByLabel("Invite link", { exact: true }).inputValue();
      check(data.viewerLink !== data.editorLink, "the viewer link is the same as the editor link");
      await sees(alice, "Invite link for viewers");
    });

    await step(carol, "joins with the viewer link", async ({ page }) => {
      await page.goto(new URL(data.viewerLink).pathname);
      await page.getByRole("heading", { name: `${data.alice.name} invited you to ${wsName}` }).waitFor();
      await sees(carol, "You'd join as a viewer.");
      await page.getByRole("button", { name: "Join workspace" }).click();
      await page.waitForURL(/\/home$/);
      const entries = await switcherEntries(carol);
      check(entries.some((e) => e.includes(wsName) && /Viewer/i.test(e)), `carol's switcher shows ${JSON.stringify(entries)}`);
    });

    await step(carol, "sees bob's workflow read-only: banner, no Save, Run or New workflow", async ({ page }) => {
      await page.goto("/workflows");
      await page.getByRole("link", { name: flow }).first().waitFor();
      check((await page.getByRole("link", { name: /New workflow/ }).count()) === 0, "a New workflow link is offered to a viewer");
      await page.goto(`/workflows/${data.wf}`);
      await sees(carol, "You're a viewer here. You can look, but not change or run workflows.");
      check((await page.locator("#wf-name").inputValue()) === flow, "carol sees a different workflow name");
      check((await page.locator("#wf-name").getAttribute("readonly")) !== null, "the name field is editable for a viewer");
      const controls = page.getByRole("button", { name: /^(Save|Saved|Create|Run now|Run|Save and run|Delete workflow)$/ });
      const enabled = [];
      for (const b of await controls.all()) if ((await b.isVisible()) && (await b.isEnabled())) enabled.push(await b.innerText());
      check(enabled.length === 0, `enabled controls for a viewer: ${enabled.join(", ")}`);
    });

    await step(carol, "doesn't get the webhook URL, on the page or from the API", async ({ page }) => {
      await page.goto(`/workflows/${data.hook.id}`);
      await sees(carol, "The webhook URL is hidden from viewers");
      check(!(await page.content()).includes(data.hook.hookKey), "the webhook key is in carol's page");
      const one = await api(carol, "GET", `/workflows/${data.hook.id}`, undefined, data.ws);
      check(one.status === 200 && one.body.hookKey === "", `GET workflow for a viewer gave ${one.status}, hookKey "${one.body?.hookKey ? "<set>" : ""}"`);
      const list = await api(carol, "GET", "/workflows", undefined, data.ws);
      check(list.body.every((w) => w.hookKey === ""), "the list gives a viewer webhook keys");
    });

    await step(carol, "is refused (403) when she writes through the API directly, and nothing changes", async () => {
      const wf = (await api(alice, "GET", `/workflows/${data.wf}`, undefined, data.ws)).body;
      const tries = {
        create: await api(carol, "POST", "/workflows", logWorkflow(`${runTag} carol`), data.ws),
        update: await api(carol, "PUT", `/workflows/${data.wf}`, { ...logWorkflow(`${runTag} renamed by carol`), version: wf.version }, data.ws),
        delete: await api(carol, "DELETE", `/workflows/${data.wf}`, undefined, data.ws),
        run: await api(carol, "POST", `/workflows/${data.wf}/run`, {}, data.ws),
      };
      const wrong = Object.entries(tries).filter(([, r]) => r.status !== 403);
      check(wrong.length === 0, `expected 403s, got ${wrong.map(([k, r]) => `${k} ${r.status}`).join(", ")}`);
      const after = (await api(alice, "GET", `/workflows/${data.wf}`, undefined, data.ws)).body;
      check(after.name === flow && after.version === wf.version, `bob's workflow changed: "${after.name}" v${after.version}`);
      const all = (await api(alice, "GET", "/workflows", undefined, data.ws)).body;
      check(!all.some((w) => w.name.includes("carol")), "carol's workflow was created");
    });

    await step(frank, "isn't in the workspace: the API says it doesn't exist", async ({ page }) => {
      await page.goto("/home");
      const list = await api(frank, "GET", "/workflows", undefined, data.ws);
      const team = await api(frank, "GET", `/workspaces/${data.ws}/team`);
      const one = await api(frank, "GET", `/workflows/${data.wf}`, undefined, data.ws);
      check(list.status === 404 && team.status === 404 && one.status === 404, `frank got ${list.status} / ${team.status} / ${one.status}`);
    });

    await step(frank, "a made-up invite link says it doesn't work any more", async ({ page }) => {
      const fake = Array.from({ length: 43 }, () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"[Math.floor(Math.random() * 64)]).join("");
      await page.goto(`/join/${fake}`);
      await page.getByRole("heading", { name: "This invite link doesn't work" }).waitFor();
      await sees(frank, "doesn't work any more");
      check((await page.getByRole("button", { name: "Join workspace" }).count()) === 0, "a Join button is offered for a made-up link");
    });

    await step(alice, "makes bob a viewer in Members", async ({ page }) => {
      const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes(`/members/${data.bob.id}`));
      await page.getByLabel(`Permissions for ${data.bob.name}`).selectOption("viewer");
      check((await saved).status() === 204, "role change was not saved");
    });

    await step(bob, "his next save is refused (403), and his open editor turns read-only by itself", async ({ page }) => {
      const wf = (await api(alice, "GET", `/workflows/${data.wf}`, undefined, data.ws)).body;
      const put = await api(bob, "PUT", `/workflows/${data.wf}`, { ...logWorkflow(`${flow} v2`), version: wf.version }, data.ws);
      check(put.status === 403, `save as a new viewer gave ${put.status}`);
      const now = (await api(alice, "GET", `/workflows/${data.wf}`, undefined, data.ws)).body;
      check(now.name === flow, `the name changed to "${now.name}"`);
      // No reload: the app notices the new role on its next 30 second refresh.
      await page.getByText("You're a viewer here. You can look, but not change or run workflows.").waitFor({ timeout: 45000 });
      check((await page.getByRole("button", { name: "Save", exact: true }).count()) === 0, "Save is still offered after the role change");
    });

    await step(alice, "removes bob in Members", async ({ page }) => {
      const gone = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes(`/members/${data.bob.id}`));
      await page.getByRole("list", { name: "Members" }).getByRole("listitem").filter({ hasText: data.bob.name }).getByRole("button", { name: "Remove" }).click();
      check((await gone).status() === 204, "removal failed");
      await doesNotSee(alice, page.getByRole("list", { name: "Members" }).getByText(data.bob.name));
    });

    await step(bob, "his next request gets 404, and after a reload the workspace is gone from his switcher", async ({ page }) => {
      const res = await api(bob, "GET", "/workflows", undefined, data.ws);
      check(res.status === 404, `bob's request after removal gave ${res.status}`);
      await page.goto("/home");
      const entries = await switcherEntries(bob);
      check(!entries.some((e) => e.includes(wsName)), `bob's switcher still lists it: ${JSON.stringify(entries)}`);
      check(entries.some((e) => e.includes("Personal")), "bob has no Personal workspace");
    });

    await step(bob, "can't walk back in: the link he joined with was ended", async ({ page }) => {
      await page.goto(new URL(data.editorLink).pathname);
      await page.getByRole("heading", { name: "This invite link doesn't work" }).waitFor();
      check((await page.getByRole("button", { name: "Join workspace" }).count()) === 0, "a Join button is offered for an ended link");
      const res = await api(bob, "GET", "/workflows", undefined, data.ws);
      check(res.status === 404, `bob got back in: ${res.status}`);
    });

    await step(carol, "leaves with Leave workspace and lands in Personal", async ({ page }) => {
      await page.goto("/settings");
      await page.getByRole("button", { name: "Leave workspace" }).click();
      await page.waitForURL(/\/home$/);
      const entries = await switcherEntries(carol);
      check(!entries.some((e) => e.includes(wsName)), `carol's switcher still lists it: ${JSON.stringify(entries)}`);
      check((await me(carol)).workspaces.every((w) => w.id !== data.ws), "the API still lists the workspace for carol");
      await (await switcher(carol)).filter({ hasText: "Personal" }).waitFor();
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
