// Creates the collections' indexes (unique emails, TTLs that expire runs and sessions, query indexes).
// Run once per database, and again after adding an index:  MONGODB_URI=... npm run db:setup
import { MongoClient } from "mongodb";
import { collections, ensureIndexes } from "../worker/mongo.ts";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("Set MONGODB_URI first (see README).");
  process.exit(1);
}
const client = await MongoClient.connect(uri);
const failed = await ensureIndexes(collections(client.db(process.env.MONGODB_DB || "knotwork")));
await client.close();
if (failed.length) {
  console.error(`${failed.length} index(es) could not be created:\n- ${failed.join("\n- ")}`);
  process.exit(1);
}
console.log("Indexes are in place.");
