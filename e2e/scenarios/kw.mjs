// Helpers. Setup goes through the API with the actor's own session cookie; behaviour under test
// goes through the UI.
export async function api(a, method, path, body, workspace) {
  return a.page.evaluate(
    async ({ method, path, body, workspace }) => {
      const headers = { "content-type": "application/json" };
      if (workspace) headers["x-knotwork-workspace"] = workspace;
      const res = await fetch("/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { method, path, body, workspace },
  );
}

export async function me(a) {
  if (!a.page.url().startsWith("http")) await a.page.goto("/home");
  return (await api(a, "GET", "/me")).body;
}
export const personal = async (a) => (await me(a)).workspaces.find((w) => w.personal).id;

export const logWorkflow = (name) => ({
  name,
  description: "",
  enabled: true,
  trigger: { type: "manual" },
  steps: [{ id: "log_1", name: "Log", type: "log", retry: { max: 0, backoffSeconds: 5 }, config: { message: "hello" } }],
});

/** Deletes every workflow in every workspace of this account whose name has the run tag, and its extra workspaces. */
export async function cleanup(a, runTag) {
  const m = await me(a);
  for (const ws of m.workspaces) {
    const list = (await api(a, "GET", "/workflows", undefined, ws.id)).body ?? [];
    for (const wf of list) if (wf.name.includes(runTag)) await api(a, "DELETE", `/workflows/${wf.id}`, undefined, ws.id);
    if (!ws.personal && ws.name.includes(runTag.slice(-4))) await api(a, "DELETE", `/workspaces/${ws.id}`);
  }
}

/** The sidebar of the app, opening the drawer first on a phone. */
export async function sidebar(a) {
  const menu = a.page.getByRole("button", { name: "Open menu" });
  if (await menu.isVisible()) await menu.click();
  return a.page.getByRole("dialog", { name: "Menu" }).or(a.page.locator("aside").first());
}

const startsWith = (name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

/** The workspace switcher button at the top of the sidebar (opens the drawer first on a phone). */
export async function switcher(a) {
  return (await sidebar(a)).getByRole("region", { name: / workspace$/ }).getByRole("button").first();
}

/** Picks a workspace from the switcher menu, like a person would. */
export async function switchTo(a, name) {
  await (await switcher(a)).click();
  await a.page.getByRole("menuitemradio", { name: startsWith(name) }).click();
  await a.page.waitForURL(/\/home$/);
  await (await switcher(a)).filter({ hasText: name }).waitFor();
}

/** The names in the switcher menu, as shown (role tags included), then closes it again. */
export async function switcherEntries(a) {
  await (await switcher(a)).click();
  const items = a.page.getByRole("menuitemradio");
  await items.first().waitFor();
  const names = (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  await a.page.keyboard.press("Escape");
  return names;
}

/** A script calling the API with a key: plain Node fetch, so no cookies and no Origin header. */
export async function keyApi(baseURL, key, method, path, body) {
  const headers = { authorization: `Bearer ${key}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(new URL("/api" + path, baseURL), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json };
}

/** Horizontal overflow of the page in px (0 or less means nothing scrolls sideways). */
export const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
