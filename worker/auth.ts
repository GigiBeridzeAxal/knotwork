import type { Collections, SessionDoc, UserDoc } from "./mongo";
import { randomId } from "./mongo";

/**
 * Passwords are hashed with PBKDF2-SHA-256 through Web Crypto. 100,000 iterations is the most the
 * Workers runtime allows; the count is stored with each hash so it can be raised later.
 */
export const PBKDF2_ITERATIONS = 100_000;
export const SESSION_DAYS = 30;
export const SESSION_COOKIE = "kw_session";

const enc = new TextEncoder();

const toB64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (text: string) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<NonNullable<UserDoc["password"]>> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return { hash: toB64(hash), salt: toB64(salt), iterations: PBKDF2_ITERATIONS };
}

/** Constant-time comparison, so the time taken says nothing about how much of the hash matched. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: UserDoc["password"]): Promise<boolean> {
  if (!stored) return false;
  const hash = await pbkdf2(password, fromB64(stored.salt), stored.iterations);
  return sameBytes(hash, fromB64(stored.hash));
}

/** A fixed hash to check against when the email is unknown, so both cases take the same time. */
let decoy: Promise<NonNullable<UserDoc["password"]>> | null = null;
export const decoyPassword = () => (decoy ??= hashPassword("knotwork-decoy-password"));

export async function sha256(text: string): Promise<string> {
  return toB64(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export async function createSession(c: Collections, user: Pick<UserDoc, "_id" | "demo">, now: number) {
  const token = randomId(32);
  const workspaceIds = (await c.workspaces.find({ ownerId: user._id }, { projection: { _id: 1 } }).toArray()).map((w) => w._id);
  await c.sessions.insertOne({
    _id: await sha256(token),
    userId: user._id,
    demo: user.demo,
    workspaceIds,
    createdAt: now,
    expiresAt: new Date(now + SESSION_DAYS * 86_400_000),
  });
  return token;
}

export async function findSession(c: Collections, token: string): Promise<SessionDoc | null> {
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
  const session = await c.sessions.findOne({ _id: await sha256(token) });
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  return session;
}

export function sessionCookie(token: string, secure: boolean) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`;
}

export function clearedCookie(secure: boolean) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function readCookie(header: string | undefined, name: string): string {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

/**
 * A fixed-window counter: adds one and says whether the window is still under `max`. Windows live in
 * MongoDB with a TTL, so they clean themselves up.
 */
export async function underLimit(c: Collections, key: string, windowMs: number, max: number, now = Date.now()) {
  const window = Math.floor(now / windowMs);
  const doc = await c.counters.findOneAndUpdate(
    { _id: `${key}:${window}` },
    { $inc: { n: 1 }, $setOnInsert: { expiresAt: new Date((window + 1) * windowMs) } },
    { upsert: true, returnDocument: "after" },
  );
  return (doc?.n ?? 1) <= max;
}

/** Reads a counter without adding to it. */
export async function counterValue(c: Collections, key: string, windowMs: number, now = Date.now()) {
  const doc = await c.counters.findOne({ _id: `${key}:${Math.floor(now / windowMs)}` });
  return doc?.n ?? 0;
}
