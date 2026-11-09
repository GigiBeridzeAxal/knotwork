import { LIMITS } from "../shared/limits";
import type { Collections, SessionDoc, UserDoc } from "./mongo";
import { randomId } from "./mongo";

export { API_KEY_PREFIX_CHARS, apiKeyValid, hookKeyValid, newApiKey, newHookKey } from "./hookKey";

/**
 * Passwords: PBKDF2-SHA-256 over HMAC-SHA-256(pepper, password), with a random salt per password.
 *
 * The Workers free plan allows about 10 ms of CPU per request, and 100,000 PBKDF2 rounds take
 * ~45 ms, so the round count is low. The pepper makes up for it: it is a Wrangler secret that never
 * enters the database, so a copy of the database alone can't be used to guess passwords. Each hash
 * stores its own round count, so it can be raised on a paid plan without breaking old accounts.
 */
export const PBKDF2_ITERATIONS = 10_000;
export const SESSION_DAYS = 30;
export const DEMO_SESSION_DAYS = 1;
/** `__Host-` makes browsers refuse the cookie from any other subdomain of gigiberidze.com (HTTPS only). */
export const cookieName = (secure: boolean) => (secure ? "__Host-kw_session" : "kw_session");

const enc = new TextEncoder();

const toB64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (text: string) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

async function hmac(pepper: string, password: string): Promise<Uint8Array> {
  if (!pepper || pepper.length < 16) throw new Error("AUTH_PEPPER is missing or shorter than 16 characters");
  const key = await crypto.subtle.importKey("raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(password)));
}

async function pbkdf2(secret: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", secret, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, pepper: string): Promise<NonNullable<UserDoc["password"]>> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(await hmac(pepper, password), salt, PBKDF2_ITERATIONS);
  return { hash: toB64(hash), salt: toB64(salt), iterations: PBKDF2_ITERATIONS };
}

/** Constant-time comparison, so the time taken says nothing about how much of the hash matched. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: UserDoc["password"], pepper: string): Promise<boolean> {
  if (!stored) return false;
  const hash = await pbkdf2(await hmac(pepper, password), fromB64(stored.salt), stored.iterations);
  return sameBytes(hash, fromB64(stored.hash));
}

/** Checked when the email is unknown, so a wrong email and a wrong password take the same time. */
export const DECOY_PASSWORD = { hash: toB64(new Uint8Array(32)), salt: toB64(new Uint8Array(16)), iterations: PBKDF2_ITERATIONS };

/**
 * Recovery codes: 12 characters from an alphabet without the look-alikes I, L, O and U (60 random
 * bits), shown as ABCD-EFGH-JKMN. They are the only way back into an account whose password is
 * lost, since Knotwork sends no email.
 *
 * A code is random, so unlike a password it needs no slow hash: what is stored is
 * HMAC-SHA-256(pepper, user id and code). Without the pepper (a Wrangler secret that never enters
 * the database) a copy of the database can't be used to test guesses.
 */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_CHARS = 12;

export function newRecoveryCodes(count: number): string[] {
  return Array.from({ length: count }, () => {
    // 32 symbols, so the low five bits of each random byte pick one without bias.
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_CHARS));
    const raw = Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join("");
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
  });
}

/** A typed code without dashes or spaces, in capitals, with the look-alikes read as intended. */
export const normalizeRecoveryCode = (code: string) =>
  code.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");

export async function recoveryCodeHash(pepper: string, userId: string, code: string): Promise<string> {
  return toB64(await hmac(pepper, `recovery:${userId}:${normalizeRecoveryCode(code)}`));
}

export async function sha256(text: string): Promise<string> {
  return toB64(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

/** The same hash in base64url, for ids that also appear in URLs (invite links, API keys). */
export async function sha256url(text: string): Promise<string> {
  return (await sha256(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createSession(c: Collections, user: Pick<UserDoc, "_id" | "demo">, now: number) {
  const token = randomId(32);
  const workspaceIds = (await c.workspaces.find({ ownerId: user._id }, { projection: { _id: 1 } }).toArray()).map((w) => w._id);
  const days = user.demo ? DEMO_SESSION_DAYS : SESSION_DAYS;
  const id = await sha256(token);
  await c.sessions.insertOne({
    _id: id,
    userId: user._id,
    demo: user.demo,
    workspaceIds,
    createdAt: now,
    expiresAt: new Date(now + days * 86_400_000),
  });
  // Keep at most LIMITS.sessionsPerAccount, so logging in over and over can't fill the database.
  // (The shared demo account is the exception: everyone shares it, and its sessions last a day.)
  if (!user.demo) {
    const old = await c.sessions
      .find({ userId: user._id }, { projection: { _id: 1 } })
      .sort({ createdAt: -1 })
      .skip(LIMITS.sessionsPerAccount)
      .toArray();
    if (old.length) await c.sessions.deleteMany({ _id: { $in: old.map((s) => s._id) } });
  }
  return { token, maxAge: days * 86_400 };
}

export async function findSession(c: Collections, token: string): Promise<SessionDoc | null> {
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
  const session = await c.sessions.findOne({ _id: await sha256(token) });
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  return session;
}

export function sessionCookie(token: string, secure: boolean, maxAge = SESSION_DAYS * 86_400) {
  return `${cookieName(secure)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearedCookie(secure: boolean) {
  return `${cookieName(secure)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function readCookie(header: string | undefined, name: string): string {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

/**
 * The part of an IP that identifies one network: the whole IPv4 address, or an IPv6 prefix (/64 by
 * default; sign-ups use /48, since anyone can get a /48 with 65,536 /64s in it for free).
 */
export function ipKey(ip: string, prefix: 48 | 64 = 64): string {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const full = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return full.slice(0, prefix / 16).map((h) => h.replace(/^0+(?=.)/, "")).join(":") + `::/${prefix}`;
}

/**
 * A fixed-window counter: adds `by` and says whether the window is still within `max`. The add and
 * the read are one atomic update, so parallel requests can't all slip under the limit. Windows live
 * in MongoDB with a TTL, so they clean themselves up.
 */
export async function underLimit(c: Collections, key: string, windowMs: number, max: number, now = Date.now(), by = 1) {
  return (await bump(c, key, windowMs, now, by)) <= max;
}

/** Adds `by` to a fixed-window counter and returns its new value, in one atomic update. */
export async function bump(c: Collections, key: string, windowMs: number, now = Date.now(), by = 1): Promise<number> {
  const window = Math.floor(now / windowMs);
  const add = () =>
    c.counters.findOneAndUpdate(
      { _id: `${key}:${window}` },
      { $inc: { n: by }, $setOnInsert: { expiresAt: new Date((window + 1) * windowMs) } },
      { upsert: true, returnDocument: "after" },
    );
  let doc;
  try {
    doc = await add();
  } catch (err) {
    // Two first requests in a window can both try to create the counter; the loser adds to it.
    if ((err as { code?: number }).code !== 11000) throw err;
    doc = await add();
  }
  return doc?.n ?? by;
}

/** Gives back one unit taken by `underLimit`, e.g. when a login turned out to be right. */
export async function giveBack(c: Collections, key: string, windowMs: number, now = Date.now()) {
  await c.counters.updateOne({ _id: `${key}:${Math.floor(now / windowMs)}`, n: { $gt: 0 } }, { $inc: { n: -1 } });
}

/** Reads a counter without adding to it. */
export async function counterValue(c: Collections, key: string, windowMs: number, now = Date.now()) {
  const doc = await c.counters.findOne({ _id: `${key}:${Math.floor(now / windowMs)}` });
  return doc?.n ?? 0;
}
