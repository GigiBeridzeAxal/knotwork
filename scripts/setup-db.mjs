// Creates the collections' indexes (unique emails, TTLs that expire runs and sessions, query indexes).
// Run once per database, and again after adding an index:  MONGODB_URI=... npm run db:setup
import dns from "node:dns";
import { MongoClient } from "mongodb";
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
const failed = await ensureIndexes(collections(client.db(process.env.MONGODB_DB || "knotwork")));
await client.close();
if (failed.length) {
  console.error(`${failed.length} index(es) could not be created:\n- ${failed.join("\n- ")}`);
  process.exit(1);
}
console.log("Indexes are in place.");
