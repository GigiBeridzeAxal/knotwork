/**
 * Webhook keys carry their own signature: 12 random bytes plus the first 6 bytes of
 * HMAC-SHA-256(pepper, those bytes), 24 characters of base64url. The webhook route checks the
 * signature with CPU alone, so made-up keys never reach the database or the rate limiter.
 * (No imports, so scripts/setup-db.mjs can load it with plain Node.)
 */

const enc = new TextEncoder();
const RANDOM_BYTES = 12;
const TAG_BYTES = 6;
const KEY = /^[A-Za-z0-9_-]{24}$/;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));

async function tag(pepper: string, random: Uint8Array): Promise<Uint8Array> {
  if (!pepper || pepper.length < 16) throw new Error("AUTH_PEPPER is missing or shorter than 16 characters");
  const key = await crypto.subtle.importKey("raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`hook:${b64url(random)}`));
  return new Uint8Array(mac).slice(0, TAG_BYTES);
}

export async function newHookKey(pepper: string): Promise<string> {
  const random = crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
  const key = new Uint8Array(RANDOM_BYTES + TAG_BYTES);
  key.set(random);
  key.set(await tag(pepper, random), RANDOM_BYTES);
  return b64url(key);
}

export async function hookKeyValid(key: string, pepper: string): Promise<boolean> {
  if (!KEY.test(key)) return false;
  const bytes = fromB64url(key);
  const expected = await tag(pepper, bytes.slice(0, RANDOM_BYTES));
  // Constant time: compare every byte.
  let diff = 0;
  for (let i = 0; i < TAG_BYTES; i++) diff |= bytes[RANDOM_BYTES + i] ^ expected[i];
  return diff === 0;
}
