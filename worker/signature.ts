import { LIMITS } from "../shared/limits";
import type { SignatureProvider } from "../shared/schema";

/**
 * Checks that a webhook call was signed by the service it claims to come from, using the signing
 * secret that service shows when the webhook is set up there.
 *
 *   GitHub  X-Hub-Signature-256: sha256=<hex of HMAC-SHA-256(secret, body)>
 *   Stripe  Stripe-Signature: t=<unix seconds>,v1=<hex of HMAC-SHA-256(secret, "<t>.<body>")>[,v1=…]
 *           The time must be within a few minutes of now, so a captured call can't be sent again later.
 *
 * Returns why the call is refused, or null when the signature is good.
 */
export async function signatureProblem(
  provider: SignatureProvider,
  secret: string,
  headers: Headers,
  body: Uint8Array,
  now = Date.now(),
): Promise<string | null> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sign = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.sign("HMAC", key, data));

  if (provider === "github") {
    const header = headers.get("x-hub-signature-256") ?? "";
    if (!header.startsWith("sha256=")) return "The X-Hub-Signature-256 header is missing";
    return sameBytes(fromHex(header.slice(7)), await sign(body)) ? null : "The signature doesn't match";
  }

  const header = headers.get("stripe-signature") ?? "";
  let time = "";
  const given: string[] = [];
  for (const part of header.split(",").slice(0, 10)) {
    const [name, value = ""] = part.trim().split("=", 2);
    if (name === "t") time = value;
    else if (name === "v1") given.push(value);
  }
  if (!/^\d{1,12}$/.test(time) || !given.length) return "The Stripe-Signature header is missing or incomplete";
  if (Math.abs(now / 1000 - Number(time)) > LIMITS.signatureToleranceSeconds) return "The signature is too old";
  const prefix = new TextEncoder().encode(`${time}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const expected = await sign(signed);
  // Stripe sends two signatures while a signing secret is being rolled; either may match.
  let ok = false;
  for (const hex of given) ok = sameBytes(fromHex(hex), expected) || ok;
  return ok ? null : "The signature doesn't match";
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^([0-9a-f]{2}){32}$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16));
}

/** Compares in constant time: every byte is looked at, whether or not an earlier one differed. */
function sameBytes(given: Uint8Array | null, expected: Uint8Array): boolean {
  if (!given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given[i] ^ expected[i];
  return diff === 0;
}
