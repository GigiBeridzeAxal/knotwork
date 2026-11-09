/**
 * Webhook keys carry their own signature: 12 random bytes plus the first 6 bytes of
 * HMAC-SHA-256(pepper, those bytes), 24 characters of base64url. The webhook route checks the
 * signature with CPU alone, so made-up keys never reach the database or the rate limiter.
 * (No imports, so scripts/setup-db.mjs can load it with plain Node.)
 */

const enc = new TextEncoder();
const TAG_BYTES = 6;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));

async function tag(pepper: string, label: string, random: Uint8Array): Promise<Uint8Array> {
  if (!pepper || pepper.length < 16) throw new Error("AUTH_PEPPER is missing or shorter than 16 characters");
  const key = await crypto.subtle.importKey("raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${label}:${b64url(random)}`));
  return new Uint8Array(mac).slice(0, TAG_BYTES);
}

/** `randomBytes` random bytes followed by their 6-byte tag, as base64url. The label keeps kinds apart. */
async function signedToken(pepper: string, label: string, randomBytes: number): Promise<string> {
  const random = crypto.getRandomValues(new Uint8Array(randomBytes));
  const token = new Uint8Array(randomBytes + TAG_BYTES);
  token.set(random);
  token.set(await tag(pepper, label, random), randomBytes);
  return b64url(token);
}

async function signedTokenValid(token: string, pepper: string, label: string, randomBytes: number): Promise<boolean> {
  const bytes = fromB64url(token);
  if (bytes.length !== randomBytes + TAG_BYTES) return false;
  const expected = await tag(pepper, label, bytes.slice(0, randomBytes));
  // Constant time: compare every byte.
  let diff = 0;
  for (let i = 0; i < TAG_BYTES; i++) diff |= bytes[randomBytes + i] ^ expected[i];
  return diff === 0;
}

const HOOK_RANDOM_BYTES = 12;
const HOOK_KEY = /^[A-Za-z0-9_-]{24}$/;

export const newHookKey = (pepper: string) => signedToken(pepper, "hook", HOOK_RANDOM_BYTES);

export async function hookKeyValid(key: string, pepper: string): Promise<boolean> {
  return HOOK_KEY.test(key) && signedTokenValid(key, pepper, "hook", HOOK_RANDOM_BYTES);
}

/**
 * API keys are signed the same way: `kw_` plus 24 random bytes and their tag (43 characters in all).
 * A made-up key is turned away with CPU alone, before any database lookup.
 */
const API_RANDOM_BYTES = 24;
const API_KEY = /^kw_[A-Za-z0-9_-]{40}$/;
export const API_KEY_PREFIX_CHARS = 9;

export const newApiKey = async (pepper: string) => `kw_${await signedToken(pepper, "apikey", API_RANDOM_BYTES)}`;

export async function apiKeyValid(key: string, pepper: string): Promise<boolean> {
  return API_KEY.test(key) && signedTokenValid(key.slice(3), pepper, "apikey", API_RANDOM_BYTES);
}
