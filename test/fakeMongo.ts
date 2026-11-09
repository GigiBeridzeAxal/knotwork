import type { Collections } from "../worker/mongo";

/**
 * A small in-memory stand-in for the MongoDB collections, with just the operations the API uses, so
 * the access tests (teams, recovery codes, API keys) run in plain `npm test` with no database.
 * With MONGODB_TEST_URI set, the same tests run against a real MongoDB instead; that is the result
 * that counts when the two disagree.
 */

type Doc = Record<string, any>;

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
const num = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number));

function matchValue(value: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && Object.keys(cond).some((k) => k.startsWith("$"))) {
    return Object.entries(cond as Doc).every(([op, arg]) => {
      switch (op) {
        case "$in":
          return (arg as unknown[]).some((x) => matchValue(value, x));
        case "$ne":
          return !matchValue(value, arg);
        case "$gt":
          return value != null && num(value) > num(arg);
        case "$gte":
          return value != null && num(value) >= num(arg);
        case "$lt":
          return value != null && num(value) < num(arg);
        case "$lte":
          return value != null && num(value) <= num(arg);
        default:
          throw new Error(`fakeMongo: operator ${op} isn't supported`);
      }
    });
  }
  // Like MongoDB, a plain value matches an array field that contains it.
  if (Array.isArray(value)) return value.some((x) => same(x, cond));
  return same(value ?? null, cond ?? null);
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") return (cond as Doc[]).some((f) => matches(doc, f));
    if (key === "$and") return (cond as Doc[]).every((f) => matches(doc, f));
    if (key.startsWith("$")) throw new Error(`fakeMongo: operator ${key} isn't supported`);
    return matchValue(key.split(".").reduce((v: any, part) => v?.[part], doc), cond);
  });
}

function applyUpdate(doc: Doc, update: Doc, inserting: boolean) {
  for (const [op, fields] of Object.entries(update)) {
    for (const [key, arg] of Object.entries(fields as Doc)) {
      if (op === "$set" || (op === "$setOnInsert" && inserting)) doc[key] = structuredClone(arg);
      else if (op === "$setOnInsert") continue;
      else if (op === "$inc") doc[key] = (doc[key] ?? 0) + (arg as number);
      else if (op === "$addToSet") doc[key] = (doc[key] ?? []).includes(arg) ? doc[key] : [...(doc[key] ?? []), arg];
      else if (op === "$pull") doc[key] = (doc[key] ?? []).filter((x: unknown) => !same(x, arg));
      else if (op === "$unset") delete doc[key];
      else throw new Error(`fakeMongo: update operator ${op} isn't supported`);
    }
  }
}

class Cursor {
  private docs: Doc[];
  constructor(docs: Doc[]) {
    this.docs = docs;
  }
  sort(spec: Record<string, 1 | -1>) {
    const keys = Object.entries(spec);
    this.docs.sort((a, b) => {
      for (const [k, dir] of keys) {
        const [x, y] = [num(a[k] ?? 0), num(b[k] ?? 0)];
        if (x !== y) return (x < y ? -1 : 1) * dir;
      }
      return 0;
    });
    return this;
  }
  skip(n: number) {
    this.docs = this.docs.slice(n);
    return this;
  }
  limit(n: number) {
    this.docs = this.docs.slice(0, n);
    return this;
  }
  async toArray() {
    return this.docs.map((d) => structuredClone(d));
  }
}

export class FakeCollection {
  docs = new Map<string, Doc>();
  private unique: string[];
  constructor(unique: string[] = []) {
    this.unique = unique;
  }

  private all(filter: Doc) {
    return [...this.docs.values()].filter((d) => matches(d, filter));
  }
  private duplicate(doc: Doc) {
    const clash = this.docs.has(doc._id) || this.unique.some((f) => [...this.docs.values()].some((d) => d[f] === doc[f]));
    if (clash) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  }

  async findOne(filter: Doc = {}) {
    const doc = this.all(filter)[0];
    return doc ? structuredClone(doc) : null;
  }
  find(filter: Doc = {}) {
    return new Cursor(this.all(filter));
  }
  async countDocuments(filter: Doc = {}, options: { limit?: number } = {}) {
    const n = this.all(filter).length;
    return options.limit ? Math.min(n, options.limit) : n;
  }
  async distinct(field: string, filter: Doc = {}) {
    return [...new Set(this.all(filter).map((d) => d[field]))];
  }
  async insertOne(doc: Doc) {
    this.duplicate(doc);
    this.docs.set(doc._id, structuredClone(doc));
    return { insertedId: doc._id };
  }
  async updateOne(filter: Doc, update: Doc, options: { upsert?: boolean } = {}) {
    const doc = this.all(filter)[0];
    if (doc) {
      applyUpdate(doc, update, false);
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    }
    if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    const fresh: Doc = {};
    for (const [k, v] of Object.entries(filter)) if (!k.startsWith("$") && (v === null || typeof v !== "object")) fresh[k] = v;
    applyUpdate(fresh, update, true);
    this.duplicate(fresh);
    this.docs.set(fresh._id, fresh);
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
  }
  async updateMany(filter: Doc, update: Doc) {
    const docs = this.all(filter);
    docs.forEach((d) => applyUpdate(d, update, false));
    return { matchedCount: docs.length, modifiedCount: docs.length };
  }
  async findOneAndUpdate(filter: Doc, update: Doc, options: { upsert?: boolean } = {}) {
    // Every caller asks for the document as it is after the update.
    let doc = this.all(filter)[0];
    if (doc) applyUpdate(doc, update, false);
    else if (options.upsert) {
      await this.updateOne(filter, update, options);
      doc = this.docs.get(filter._id)!;
    }
    return doc ? structuredClone(doc) : null;
  }
  async deleteOne(filter: Doc) {
    const doc = this.all(filter)[0];
    if (doc) this.docs.delete(doc._id);
    return { deletedCount: doc ? 1 : 0 };
  }
  async deleteMany(filter: Doc) {
    const docs = this.all(filter);
    docs.forEach((d) => this.docs.delete(d._id));
    return { deletedCount: docs.length };
  }
  async createIndex() {
    return "fake";
  }
  async dropIndex() {}
}

/** What the Worker expects of its database connection (`Env.SHARED_MONGO`), backed by memory. */
export function fakeMongo() {
  const c = {
    users: new FakeCollection(["email"]),
    sessions: new FakeCollection(),
    workspaces: new FakeCollection(),
    workflows: new FakeCollection(["hookKey"]),
    runs: new FakeCollection(),
    counters: new FakeCollection(),
    members: new FakeCollection(),
    invites: new FakeCollection(),
    apiKeys: new FakeCollection(),
  };
  return { c: c as unknown as Collections, raw: c, started: 0, connected: 0, async close() {} };
}
