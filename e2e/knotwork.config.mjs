// Knotwork with accounts. Five actors have test accounts (made by prep.mjs, signed in by
// `bst.mjs login`); dave has none and plays the logged-out visitor who signs up.
export default {
  app: "Knotwork (accounts and workspaces)",
  baseURL: process.env.BST_BASE_URL ?? "http://localhost:5173",
  browsers: ["chromium", "firefox", "webkit"],
  actors: [
    { name: "alice", role: "owner", storageState: "auth/alice.json", credentials: { email: "env:ALICE_EMAIL", password: "env:ALICE_PASSWORD" } },
    { name: "bob", role: "other account", storageState: "auth/bob.json", credentials: { email: "env:BOB_EMAIL", password: "env:BOB_PASSWORD" } },
    { name: "carol", role: "stranger", storageState: "auth/carol.json", credentials: { email: "env:CAROL_EMAIL", password: "env:CAROL_PASSWORD" } },
    { name: "dave", role: "logged-out visitor" },
    { name: "erin", role: "phone user", browser: "webkit", device: "iPhone 14", storageState: "auth/erin.json", credentials: { email: "env:ERIN_EMAIL", password: "env:ERIN_PASSWORD" } },
    { name: "frank", role: "heavy user (limits)", storageState: "auth/frank.json", credentials: { email: "env:FRANK_EMAIL", password: "env:FRANK_PASSWORD" } },
  ],
  async login({ page, creds }) {
    await page.goto("/login");
    await page.getByLabel("Email").fill(creds.email);
    await page.getByLabel("Password").fill(creds.password);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.waitForURL("**/home");
  },
  loginGapMs: 300,
  scenarios: [
    "scenarios/01-isolation.mjs",
    "scenarios/02-signup-login.mjs",
    "scenarios/03-demo.mjs",
    "scenarios/04-workspaces.mjs",
    "scenarios/05-conflict.mjs",
    "scenarios/06-limits.mjs",
    "scenarios/07-phone.mjs",
    "scenarios/08-account.mjs",
    "scenarios/10-landing.mjs",
    "scenarios/11-editor-early-edit.mjs",
    "scenarios/12-docs-demo.mjs",
    "scenarios/13-canvas.mjs",
    "scenarios/14-templates-import.mjs",
    "scenarios/15-history-test-step.mjs",
    "scenarios/16-teams.mjs",
    "scenarios/17-recovery.mjs",
    "scenarios/18-api-keys.mjs",
    "scenarios/19-phone-join.mjs",
    "scenarios/20-connectors.mjs",
  ],
  retries: 2,
  timeouts: { action: 10000, step: 30000, scenario: 180000 },
};
