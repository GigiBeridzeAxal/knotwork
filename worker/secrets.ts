import { LIMITS } from "../shared/limits";
import { SECRET_NAME, type SecretInfo } from "../shared/schema";
import type { Collections, SecretDoc } from "./mongo";

/**
 * Workspace secrets: API keys and tokens a workflow uses as `{{ secrets.NAME }}` without the value
 * being part of the workflow.
 *
 * A value is encrypted with AES-256-GCM before it is stored. The key is derived (HKDF-SHA-256) from
 * AUTH_PEPPER, which only the Worker has, with the workspace id as salt: a copy of the database alone
 * can't be decrypted, and each workspace has its own key. The workspace id and the secret's name are
 * bound into the ciphertext, so a stored value can't be moved to another name or workspace. Values are
 * never sent back to the dashboard, and the engine hides them in everything a run stores (`redactor`).
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text: string) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

async function workspaceKey(pepper: string, workspaceId: string): Promise<CryptoKey> {
  if (!pepper || pepper.length < 16) throw new Error("AUTH_PEPPER is missing or shorter than 16 characters");
  const base = await crypto.subtle.importKey("raw", enc.encode(pepper), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(workspaceId), info: enc.encode("knotwork:secrets:v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const bound = (workspaceId: string, name: string) => enc.encode(`${workspaceId}:${name}`);
const secretId = (workspaceId: string, name: string) => `${workspaceId}:${name}`;

export async function seal(key: CryptoKey, workspaceId: string, name: string, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: bound(workspaceId, name) }, key, enc.encode(value));
  return { iv: toB64(iv), data: toB64(new Uint8Array(data)) };
}

export async function unseal(key: CryptoKey, workspaceId: string, name: string, sealed: { iv: string; data: string }): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(sealed.iv), additionalData: bound(workspaceId, name) },
    key,
    fromB64(sealed.data),
  );
  return dec.decode(plain);
}

export async function listSecrets(c: Collections, workspaceId: string): Promise<SecretInfo[]> {
  const docs = await c.secrets
    .find({ workspaceId }, { projection: { name: 1, updatedAt: 1 } })
    .sort({ name: 1 })
    .limit(LIMITS.secretsPerWorkspace)
    .toArray();
  return docs.map((d) => ({ name: d.name, updatedAt: d.updatedAt }));
}

/** Adds a secret or replaces its value. "full" when the workspace already has as many as it can. */
export async function putSecret(
  c: Collections,
  pepper: string,
  workspaceId: string,
  ownerId: string,
  name: string,
  value: string,
  now: number,
): Promise<SecretInfo | "full" | "gone"> {
  const sealed = await seal(await workspaceKey(pepper, workspaceId), workspaceId, name, value);
  const _id = secretId(workspaceId, name);
  const res = await c.secrets.updateOne(
    { _id },
    { $set: { ...sealed, updatedAt: now }, $setOnInsert: { workspaceId, ownerId, name, createdAt: now } },
    { upsert: true },
  );
  if (res.upsertedCount) {
    // Insert, then count, like workflows: two requests at once can't both squeeze under the limit, and
    // a workspace deleted in the meantime doesn't keep a secret nobody can see.
    const [count, workspace] = await Promise.all([
      c.secrets.countDocuments({ workspaceId }),
      c.workspaces.findOne({ _id: workspaceId }, { projection: { _id: 1 } }),
    ]);
    if (count > LIMITS.secretsPerWorkspace || !workspace) {
      await c.secrets.deleteOne({ _id });
      return workspace ? "full" : "gone";
    }
  }
  return { name, updatedAt: now };
}

export async function deleteSecret(c: Collections, workspaceId: string, name: string): Promise<boolean> {
  return (await c.secrets.deleteOne({ _id: secretId(workspaceId, name) })).deletedCount > 0;
}

/**
 * The values of the named secrets, for one run. A name that isn't set, or a value that can't be
 * decrypted (stored under another AUTH_PEPPER), is left out; the step that needs it then fails saying so.
 */
export async function loadSecrets(
  c: Collections,
  pepper: string,
  workspaceId: string,
  names: Iterable<string>,
  /** Filled with the names that are saved but can't be decrypted, when given. */
  unreadable?: Set<string>,
): Promise<Record<string, string>> {
  const ids = [...names].filter((n) => SECRET_NAME.test(n)).map((n) => secretId(workspaceId, n));
  const values: Record<string, string> = {};
  if (!ids.length || !pepper) return values;
  const docs: SecretDoc[] = await c.secrets.find({ _id: { $in: ids }, workspaceId }).toArray();
  if (!docs.length) return values;
  const key = await workspaceKey(pepper, workspaceId);
  for (const doc of docs) {
    try {
      values[doc.name] = await unseal(key, workspaceId, doc.name, doc);
    } catch {
      unreadable?.add(doc.name);
      console.error(`secret ${doc._id} could not be decrypted`);
    }
  }
  return values;
}

const SECRET_REF = /\{\{\s*secrets\.([\w$-]+)/g;

/** The secret names the templates inside a JSON value mention. */
export function secretRefs(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (value.includes("secrets.")) for (const m of value.matchAll(SECRET_REF)) into.add(m[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) secretRefs(item, into);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) secretRefs(item, into);
  }
  return into;
}

/**
 * Hides secret values in anything a run is about to store or hand to a later step: every place a
 * value appears, as it is, as it looks inside JSON text, or URL-encoded, becomes `[secret NAME]`. So a
 * service that echoes a request back doesn't put the key in the run log. A value changed in another
 * way (hashed, base64, cut in pieces) can't be recognised.
 */
/** A piece of a URL secret is hidden by itself only from this length, so short common words aren't. */
const PART_MIN = 8;

/** The shapes one secret value can take in text. */
function shapes(value: string): Set<string> {
  const found = new Set<string>();
  const add = (text: string) => {
    if (!text) return;
    const json = JSON.stringify(text).slice(1, -1);
    // Also as some services echo it: with JSON's optional `\/`, and with `+` read as a space.
    for (const form of [text, json, encodeURIComponent(text), json.replaceAll("/", "\\/"), text.replaceAll("+", " ")]) found.add(form);
  };
  add(value);
  // Header values and URLs are trimmed on their way out, so a service may echo the value without its edges.
  add(value.trim());
  // A secret that is a web address (a chat webhook URL) also shows up without its scheme, as the
  // parser rewrites it, and as its path alone, which is where the key sits.
  if (/^https?:\/\//i.test(value.trim())) {
    try {
      const url = new URL(value.trim());
      add(url.href);
      add(url.host + url.pathname + url.search);
      if (url.pathname.length >= 8) add(url.pathname + url.search), add(url.pathname);
      // Some services keep the key in the query (`?key=…&token=…`) or before the host, and echo it by itself.
      const parts = [...url.searchParams.values(), url.username, url.password, decodeURIComponent(url.username), decodeURIComponent(url.password)];
      if (url.search.length >= PART_MIN) add(url.search.slice(1));
      // Query values as written (not decoded), and each longer piece of the path: an error page may show only that.
      for (const pair of url.search.slice(1).split("&")) parts.push(pair.slice(pair.indexOf("=") + 1));
      parts.push(...url.pathname.split("/"));
      for (const part of parts) if (part.length >= PART_MIN) add(part);
    } catch {
      // Not an address after all.
    }
  }
  // Put into a URL, a value is encoded the parser's way, which differs from encodeURIComponent for
  // characters like | [ ] and '. And a host name comes back in small letters.
  for (const [prefix, read] of [
    ["https://x.invalid/", (u: URL) => u.pathname.slice(1)],
    ["https://x.invalid/?", (u: URL) => u.search.slice(1)],
    ["https://x.invalid/?k=", (u: URL) => u.search.slice(3)],
  ] as const) {
    try {
      add(read(new URL(prefix + value.trim())));
    } catch {
      // Can't be part of a URL as it is.
    }
  }
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value.trim())) add(value.trim().toLowerCase());
  return found;
}

export function redactor(secrets: Record<string, string>): <T>(value: T) => T {
  const forms: [string, string][] = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (!value) continue;
    const mark = `[secret ${name}]`;
    for (const form of shapes(value)) forms.push([form, mark]);
  }
  if (!forms.length) return (value) => value;
  // Longest first, so a secret that contains another one is replaced whole.
  forms.sort((a, b) => b[0].length - a[0].length);
  const text = (s: string) => {
    for (const [form, mark] of forms) if (s.includes(form)) s = s.split(form).join(mark);
    return s;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [text(k), walk(v)]));
    return value;
  };
  return (value) => walk(value) as typeof value;
}
