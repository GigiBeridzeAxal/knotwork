import { keyApi } from "./kw.mjs";

// Uses a fresh sign-up (dave), so the shared test accounts keep their passwords. Each attempt signs up
// a new address, so a retry starts clean; the account is deleted at the end.
const CODE = /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/;

async function logIn(page, email, password) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}

async function recover(page, email, code, password) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Recovery code").fill(code);
  await page.getByLabel("New password").fill(password);
  await page.getByRole("button", { name: "Set new password and log in" }).click();
}

async function logOut(page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await page.waitForURL(/\/login/);
}

const status = (page, path) => page.evaluate(async (p) => (await fetch(p)).status, path);

export default {
  name: "Recovery codes: get back in without email",
  tags: ["sessions", "outside", "lifecycle"],
  actors: ["dave"],
  expectedHttp: [401],
  async run({ actors: { dave }, step, check, sees, doesNotSee, baseURL, runTag, data, leftBehind }) {
    const tag = runTag.replace(/[^a-z0-9]/gi, "").slice(-4);
    data.email = `dave.rc.${tag}.${Date.now()}@example.com`.toLowerCase();
    data.password = `pw-${Math.random().toString(36).slice(2)}-long`;
    data.next = `new-${Math.random().toString(36).slice(2)}-long`;

    await step(dave, "signs up and Home says he has no recovery codes", async ({ page }) => {
      await page.goto("/signup");
      await page.getByLabel("Name").fill("Dave Recover");
      await page.getByLabel("Email").fill(data.email);
      await page.getByLabel("Password").fill(data.password);
      await page.getByRole("button", { name: "Create account" }).click();
      await page.waitForURL(/\/home$/);
      data.cleaned = leftBehind(`account ${data.email}`);
      await sees(dave, "No recovery codes yet");
    });

    await step(dave, "is also logged in on a second device", async () => {
      data.second = await dave.context.browser().newContext({ baseURL });
      const page = await data.second.newPage();
      await logIn(page, data.email, data.password);
      await page.waitForURL(/\/home$/);
      check((await status(page, "/api/me")) === 200, "the second device isn't logged in");
      // And a script of his has an API key (set up through the API); recovering must end it too.
      data.key = await page.evaluate(async () => {
        const me = await (await fetch("/api/me")).json();
        const ws = me.workspaces.find((w) => w.personal).id;
        const res = await fetch("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "script", workspaceId: ws, access: "read" }) });
        return (await res.json()).key;
      });
      check((await keyApi(baseURL, data.key, "GET", "/workflows")).status === 200, "the API key doesn't work before recovery");
    });

    await step(dave, "makes codes in Settings with his password and reads the 8 codes", async ({ page }) => {
      await page.getByRole("link", { name: "Make them in Settings" }).click();
      await page.waitForURL(/\/settings$/);
      await sees(dave, "You have no recovery codes.");
      await page.getByLabel("Password to confirm").fill(data.password);
      await page.getByRole("button", { name: "Make new codes" }).click();
      await page.getByTestId("recovery-code").first().waitFor();
      data.codes = (await page.getByTestId("recovery-code").allInnerTexts()).map((c) => c.trim());
      check(data.codes.length === 8, `got ${data.codes.length} codes`);
      check(new Set(data.codes).size === 8 && data.codes.every((c) => CODE.test(c)), "the codes aren't 8 different ABCD-EFGH-JKMN codes");
      await page.goto("/home");
      await doesNotSee(dave, "No recovery codes yet");
    });

    await step(dave, "logs out and finds the recovery page from the login page", async ({ page }) => {
      await logOut(page);
      await page.getByRole("link", { name: "Forgot your password?" }).click();
      await page.waitForURL(/\/recover$/);
      await page.getByRole("heading", { name: "Recover your account" }).waitFor();
    });

    await step(dave, "a wrong code is refused with the same message as an unknown email", async ({ page }) => {
      const wrong = data.codes.includes("2222-2222-2222") ? "3333-3333-3333" : "2222-2222-2222";
      const answer = async (email, code) => {
        const res = page.waitForResponse((r) => r.url().endsWith("/api/auth/recover"));
        await recover(page, email, code, data.next);
        const r = await res;
        const alert = page.getByRole("alert");
        await alert.waitFor();
        return { status: r.status(), error: (await r.json()).error, shown: (await alert.innerText()).trim() };
      };
      const forWrongCode = await answer(data.email, wrong);
      const forUnknown = await answer(`nobody.${tag}.${Date.now()}@example.com`, data.codes[1]);
      check(forWrongCode.status === 401 && forUnknown.status === 401, `statuses ${forWrongCode.status} / ${forUnknown.status}`);
      check(forWrongCode.error === forUnknown.error && forWrongCode.shown === forUnknown.shown, `messages differ: "${forWrongCode.shown}" vs "${forUnknown.shown}"`);
      check(forWrongCode.shown === forWrongCode.error && /don't match/.test(forWrongCode.shown), `unexpected message: "${forWrongCode.shown}"`);
      check(page.url().endsWith("/recover"), "a wrong code got him in");
    });

    await step(dave, "the right code, typed lowercase without dashes, sets a new password and logs him in", async ({ page }) => {
      await recover(page, data.email, data.codes[0].replace(/-/g, "").toLowerCase(), data.next);
      await page.waitForURL(/\/home$/);
      await page.goto("/settings");
      await sees(dave, "You have no recovery codes.");
    });

    await step(dave, "the second device was logged out and the API key revoked", async () => {
      const page = data.second.pages()[0];
      check((await status(page, "/api/me")) === 401, "the second device is still logged in");
      const key = await keyApi(baseURL, data.key, "GET", "/workflows");
      check(key.status === 401, `the API key made before recovery gave ${key.status}`);
      await page.goto("/home");
      await page.waitForURL(/\/login/);
    });

    await step(dave, "the old password no longer works", async ({ page }) => {
      await logOut(page);
      await logIn(page, data.email, data.password);
      await sees(dave, "don't match an account");
    });

    await step(dave, "the same code can't be used twice", async ({ page }) => {
      await page.goto("/recover");
      await recover(page, data.email, data.codes[0], `again-${data.next}`);
      await sees(dave, page.getByRole("alert").filter({ hasText: "don't match" }));
      check(page.url().endsWith("/recover"), "a used code got him in");
    });

    await step(dave, "logs in with the new password and deletes the account", async ({ page }) => {
      await logIn(page, data.email, data.next);
      await page.waitForURL(/\/home$/);
      await page.goto("/settings");
      await page.getByLabel("Your password").fill(data.next);
      await page.getByRole("button", { name: "Delete account" }).click();
      await page.waitForURL(/\/login/);
      data.cleaned();
      data.cleaned = null;
    });

    await step(dave, "cleans up what a failed attempt left (second device, account)", async ({ page }) => {
      await data.second?.close().catch(() => {});
      if (!data.cleaned) return;
      if (!page.url().startsWith("http")) await page.goto("/login");
      for (const password of [data.next, data.password]) {
        const gone = await page.evaluate(async ({ email, password }) => {
          const post = (p, body) => fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          if ((await post("/api/auth/login", { email, password })).status !== 200) return false;
          return (await post("/api/auth/delete-account", { password })).status === 204;
        }, { email: data.email, password });
        if (gone) return data.cleaned();
      }
    }, { soft: true });
  },
};
