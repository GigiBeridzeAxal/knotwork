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
