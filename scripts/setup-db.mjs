// Creates the collections' indexes (unique emails, TTLs that expire runs and sessions, query indexes).
// Run once per database, and again after adding an index:  MONGODB_URI=... npm run db:setup
// With AUTH_PEPPER set as well, it also gives a new signed key to any webhook URL made before keys
// were signed (those URLs answer 404 until then; the new URL shows in the editor).
import dns from "node:dns";
import { MongoClient } from "mongodb";
import { hookKeyValid, newHookKey } from "../worker/hookKey.ts";
import { collections, ensureIndexes } from "../worker/mongo.ts";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("Set MONGODB_URI first (see README).");
  process.exit(1);
}
// Some networks' DNS refuses the SRV lookup a mongodb+srv:// address needs ("querySrv ECONNREFUSED").
// DNS_SERVERS=1.1.1.1 makes this script ask a public resolver instead.
if (process.env.DNS_SERVERS) dns.setServers(process.env.DNS_SERVERS.split(","));
const client = await MongoClient.connect(uri);
const c = collections(client.db(process.env.MONGODB_DB || "knotwork"));
const failed = await ensureIndexes(c);

const pepper = process.env.AUTH_PEPPER;
let rekeyed = 0;
if (pepper) {
  for await (const wf of c.workflows.find({}, { projection: { _id: 1, hookKey: 1 } })) {
    if (await hookKeyValid(wf.hookKey, pepper)) continue;
    await c.workflows.updateOne({ _id: wf._id, hookKey: wf.hookKey }, { $set: { hookKey: await newHookKey(pepper) } });
    rekeyed += 1;
  }
} else {
  console.log("AUTH_PEPPER isn't set, so webhook keys weren't checked.");
}
await client.close();
if (rekeyed) console.log(`${rekeyed} webhook URL(s) made before signed keys got a new key; update their senders.`);
if (failed.length) {
  console.error(`${failed.length} index(es) could not be created:\n- ${failed.join("\n- ")}`);
  process.exit(1);
}
console.log("Indexes are in place.");
