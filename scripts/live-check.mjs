// Checks that the live site works the way a visitor needs it to: the front page loads, the API
// answers, the demo account opens and its workflows are there. Exits 1 with the reason if not.
//   node scripts/live-check.mjs [https://knotwork.gigiberidze.com]
const base = (process.argv[2] ?? process.env.KNOTWORK_URL ?? "https://knotwork.gigiberidze.com").replace(/\/$/, "");
const steps = [];

async function step(name, fn) {
  const start = Date.now();
  try {
    const note = await fn();
    steps.push(`ok    ${name} (${Date.now() - start} ms)${note ? ` ${note}` : ""}`);
  } catch (err) {
    steps.push(`FAIL  ${name}: ${err.message}`);
    console.log(steps.join("\n"));
    process.exit(1);
  }
}
async function get(path, init = {}) {
  const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(20_000) });
  return res;
}
const expect = (ok, message) => {
  if (!ok) throw new Error(message);
};

let cookie = "";
await step("front page loads", async () => {
  const res = await get("/");
  expect(res.ok, `status ${res.status}`);
  expect((await res.text()).toLowerCase().includes("knotwork"), "the page doesn't mention Knotwork");
});
await step("API answers", async () => {
  const res = await get("/api/health");
  expect(res.ok, `status ${res.status}`);
  expect((await res.json()).ok === true, "health is not ok");
});
await step("demo account opens", async () => {
  const res = await get("/api/auth/demo", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: "{}" });
  expect(res.ok, `status ${res.status}: ${(await res.text()).slice(0, 200)}`);
  cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  expect(cookie, "no session cookie came back");
});
await step("demo workflows are listed", async () => {
  const me = await get("/api/me", { headers: { cookie } });
  expect(me.ok, `/api/me status ${me.status}`);
  const workspace = (await me.json()).workspaces?.[0]?.id;
  expect(workspace, "the demo account has no workspace");
  const list = await get("/api/workflows", { headers: { cookie, "x-knotwork-workspace": workspace } });
  expect(list.ok, `/api/workflows status ${list.status}`);
  const workflows = await list.json();
  expect(Array.isArray(workflows) && workflows.length > 0, "the demo account has no workflows");
  return `${workflows.length} workflows`;
});
await get("/api/auth/logout", { method: "POST", headers: { cookie, origin: base } }).catch(() => {});
console.log(steps.join("\n"));
