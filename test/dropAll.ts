import type { Db } from "mongodb";

/**
 * Removes a throwaway test database. Atlas's readWriteAnyDatabase role can't run dropDatabase, but it
 * can drop collections, and a database with no collections is gone.
 */
export async function dropAll(db: Db) {
  const names = await db.listCollections({}, { nameOnly: true }).toArray();
  await Promise.all(names.map((c) => db.dropCollection(c.name)));
}
