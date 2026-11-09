// Gets a local Knotwork ready for the browser scenarios: writes the test accounts' credentials to
// e2e/accounts.env (random, gitignored), signs the accounts up through the API like the form does,
// and clears what earlier runs left behind. Never point this at the live database.
//   MONGODB_URI=mongodb://127.0.0.1:27017 node e2e/prep.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import { MongoClient } from "mongodb";

const base = process.env.BST_BASE_URL ?? "http://localhost:5173";
const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017";
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri)) {
  console.error("e2e/prep.mjs only runs against a MongoDB on this machine.");
  process.exit(1);
}
const names = ["alice", "bob", "carol", "erin", "frank"];
const envFile = new URL("./accounts.env", import.meta.url);
if (!fs.existsSync(envFile)) {
  const tag = crypto.randomBytes(4).toString("hex");
  const lines = names.flatMap((n) => [
    `${n.toUpperCase()}_EMAIL=${n}-${tag}@example.com`,
    `${n.toUpperCase()}_PASSWORD=${crypto.randomBytes(18).toString("base64url")}`,
  ]);
  fs.writeFileSync(envFile, lines.join("\n") + "\n");
}
const env = Object.fromEntries(fs.readFileSync(envFile, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

const client = await MongoClient.connect(uri);
const db = client.db(process.env.MONGODB_DB || "knotwork");
// Locally every request comes from one address, so the per-network limits would stop the sign-ups.
await db.collection("counters").deleteMany({});
for (const n of names) {
  const N = n.toUpperCase();
  const res = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `${n[0].toUpperCase()}${n.slice(1)} Tester`, email: env[`${N}_EMAIL`], password: env[`${N}_PASSWORD`] }),
  });
  // 201 the first time; an account that already exists is fine too.
  console.log(n, res.status);
}
const users = await db.collection("users").find({ email: { $in: names.map((n) => env[`${n.toUpperCase()}_EMAIL`].toLowerCase()) } }).toArray();
if (users.length !== names.length) {
  console.error(`Expected ${names.length} test accounts, found ${users.length}.`);
  process.exit(1);
}
const ids = users.map((u) => u._id);
await db.collection("runs").deleteMany({ ownerId: { $in: ids } });
await db.collection("workflows").deleteMany({ ownerId: { $in: ids } });
await db.collection("workspaces").deleteMany({ ownerId: { $in: ids }, personal: false });
await db.collection("counters").deleteMany({});
await client.close();
