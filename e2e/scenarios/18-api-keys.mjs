import { api, keyApi, logWorkflow, switchTo } from "./kw.mjs";

const KEY = /^kw_[A-Za-z0-9_-]{40}$/;

/** Makes a key in Settings > API keys and reads it from the one-time field. */
async function makeKey(a, name, access, check) {
  const { page } = a;
  await page.getByLabel("Key name").fill(name);
  await page.getByLabel("Access").selectOption(access);
  await page.getByRole("button", { name: "Create API key" }).click();
  const key = await page.getByLabel("Your new API key").inputValue();
  check(KEY.test(key), `the new key doesn't look like kw_ + 40 characters (length ${key.length})`);
  await page.getByRole("button", { name: "Done, hide it" }).click();
  return key;
}

export default {
  name: "API keys: script access, read vs write, revoke",
  tags: ["outside", "roles", "isolation", "lifecycle"],
  actors: ["alice", "bob"],
  expectedHttp: [401, 403, 404],
  async run({ actors: { alice, bob }, step, check, eventually, sees, doesNotSee, baseURL, runTag, data, leftBehind }) {
    const wsName = `Keys ${runTag.slice(-5, -1)}`;
    const writeName = `${runTag} write`;
    const readName = `${runTag} read`;

    await step(alice, "has a workspace for the keys (set up through the API) and picks it", async ({ page }) => {
      await page.goto("/home");
      const ws = await api(alice, "POST", "/workspaces", { name: wsName });
      check(ws.status === 201, `create workspace gave ${ws.status}`);
      data.ws = ws.body.id;
      data.cleaned = leftBehind(`workspace "${wsName}" (${data.ws}) of alice, with its keys`);
      // The app reads the list of workspaces once, when it opens: load it again so the new one is in it.
      // (Without the reload this only passed in the dev build, which used to ask for the list twice;
      // the production build never showed a workspace made outside the page until a reload.)
      await page.reload();
      await switchTo(alice, wsName);
    });

    await step(alice, "makes a read-and-write key in Settings and copies it", async ({ page }) => {
      await page.goto("/settings");
      data.write = await makeKey(alice, writeName, "write", check);
    });

    await step(alice, "her script (no cookies) lists and creates workflows with the key", async () => {
      const list = await keyApi(baseURL, data.write, "GET", "/workflows");
      check(list.status === 200 && Array.isArray(list.body), `list gave ${list.status}`);
      const made = await keyApi(baseURL, data.write, "POST", "/workflows", logWorkflow(`${runTag} from script`));
      check(made.status === 201, `create gave ${made.status}: ${made.body?.error ?? ""}`);
      check(made.body.workspaceId === data.ws, `the workflow went to ${made.body.workspaceId}, not the key's workspace`);
      check(typeof made.body.hookKey === "string" && made.body.hookKey.length > 0, "a write key got no hookKey");
      data.wf = made.body.id;
      const run = await keyApi(baseURL, data.write, "POST", `/workflows/${data.wf}/run`, { input: {} });
      check(run.status === 202 && /^run_/.test(run.body?.runId ?? ""), `starting a run gave ${run.status}`);
    });

    await step(alice, "sees the script's workflow in her dashboard", async ({ page }) => {
      await eventually(async () => {
        await page.goto("/workflows");
        return page.getByRole("link", { name: `${runTag} from script` }).first().waitFor({ timeout: 4000 }).then(() => true);
      }, { timeout: 15000, message: "the script's workflow never showed up" });
    });

    await step(alice, "the key can't reach her account or her keys (403)", async () => {
      const meRes = await keyApi(baseURL, data.write, "GET", "/me");
      const keys = await keyApi(baseURL, data.write, "GET", "/keys");
      const ws = await keyApi(baseURL, data.write, "GET", "/workspaces");
      check(meRes.status === 403 && keys.status === 403 && ws.status === 403, `/me ${meRes.status}, /keys ${keys.status}, /workspaces ${ws.status}`);
      check(!JSON.stringify(keys.body ?? {}).includes(writeName), "/keys answered with the key list");
    });

    await step(alice, "makes a read-only key; it lists without webhook URLs but can't write (403)", async ({ page }) => {
      await page.goto("/settings");
      data.read = await makeKey(alice, readName, "read", check);
      const list = await keyApi(baseURL, data.read, "GET", "/workflows");
      check(list.status === 200 && list.body.some((w) => w.id === data.wf), `read key list gave ${list.status}`);
      check(list.body.every((w) => w.hookKey === ""), "a read key got a webhook key");
      const one = await keyApi(baseURL, data.read, "GET", `/workflows/${data.wf}`);
      check(one.status === 200 && one.body.hookKey === "", `read key GET one gave ${one.status} with hookKey ${one.body?.hookKey ? "set" : "empty"}`);
      const post = await keyApi(baseURL, data.read, "POST", "/workflows", logWorkflow(`${runTag} by read key`));
      const run = await keyApi(baseURL, data.read, "POST", `/workflows/${data.wf}/run`, {});
      const del = await keyApi(baseURL, data.read, "DELETE", `/workflows/${data.wf}`);
      check(post.status === 403 && run.status === 403 && del.status === 403, `read key writes gave POST ${post.status}, run ${run.status}, DELETE ${del.status}`);
    });

    await step(alice, "after a reload both keys are listed by prefix and the full keys are nowhere on the page", async ({ page }) => {
      await page.reload();
      const list = page.getByRole("list", { name: "API keys" });
      for (const [name, key] of [[writeName, data.write], [readName, data.read]]) {
        const row = list.getByRole("listitem").filter({ hasText: name });
        await row.waitFor();
        await sees(alice, row.getByText(`${key.slice(0, 9)}…`));
      }
      await sees(alice, list.getByRole("listitem").filter({ hasText: writeName }).getByText("read and write"));
      await sees(alice, list.getByRole("listitem").filter({ hasText: readName }).getByText("read only"));
      const html = await page.content();
      const values = await page.locator("input").evaluateAll((els) => els.map((e) => e.value).join(" "));
      check(![data.write, data.read].some((k) => html.includes(k.slice(9)) || values.includes(k.slice(9))), "a full key is still on the page");
    });

    await step(bob, "his own key list doesn't show alice's keys", async ({ page }) => {
      await page.goto("/settings");
      await page.getByRole("button", { name: "Create API key" }).waitFor();
      await doesNotSee(bob, runTag);
      const keys = await api(bob, "GET", "/keys");
      check(keys.status === 200 && !keys.body.some((k) => k.name.includes(runTag) || k.workspaceId === data.ws), "bob's /keys lists alice's keys");
    });

    await step(alice, "revokes the write key in Settings; the script's next call gets 401", async ({ page }) => {
      const gone = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/api/keys/"));
      await page.getByRole("list", { name: "API keys" }).getByRole("listitem").filter({ hasText: writeName }).getByRole("button", { name: "Revoke" }).click();
      check((await gone).status() === 204, "revoke failed");
      await doesNotSee(alice, page.getByRole("list", { name: "API keys" }).getByText(writeName));
      const after = await keyApi(baseURL, data.write, "GET", "/workflows");
      check(after.status === 401, `revoked key gave ${after.status}`);
      const read = await keyApi(baseURL, data.read, "GET", "/workflows");
      check(read.status === 200, `the other key stopped working too: ${read.status}`);
    });

    await step(alice, "deletes the workspace (cleanup); its read key stops working", async ({ page }) => {
      if (!data.ws) return;
      if (!page.url().startsWith("http")) await page.goto("/home");
      const del = await api(alice, "DELETE", `/workspaces/${data.ws}`);
      check(del.status === 204, `delete workspace gave ${del.status}`);
      data.cleaned();
      if (data.read) {
        const read = await keyApi(baseURL, data.read, "GET", "/workflows");
        check(read.status === 401, `a key for a deleted workspace gave ${read.status}`);
        const keys = await api(alice, "GET", "/keys");
        check(!keys.body.some((k) => k.workspaceId === data.ws), "keys for the deleted workspace are still listed");
      }
    }, { soft: true });
  },
};
