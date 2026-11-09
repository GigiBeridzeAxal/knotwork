import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signatureProblem } from "../worker/signature";

/** Webhook signature checks for GitHub and Stripe, with HMACs worked out independently by node:crypto. */

const SECRET = "whsec_test_0123456789";
const body = '{"action":"opened","n":1}';
const bytes = (text: string) => new TextEncoder().encode(text);
const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");

describe("GitHub signatures", () => {
  const check = (header: string | null, payload = body, secret = SECRET) =>
    signatureProblem("github", secret, new Headers(header === null ? {} : { "x-hub-signature-256": header }), bytes(payload));

  it("accepts the right signature, in either case of hex", async () => {
    expect(await check(`sha256=${hmac(SECRET, body)}`)).toBeNull();
    expect(await check(`sha256=${hmac(SECRET, body).toUpperCase()}`)).toBeNull();
  });

  it("refuses a signature made with another secret, or over another body", async () => {
    expect(await check(`sha256=${hmac("another-secret", body)}`)).toBe("The signature doesn't match");
    expect(await check(`sha256=${hmac(SECRET, body)}`, body.replace("1", "2"))).toBe("The signature doesn't match");
  });

  it("refuses a missing header or one in the wrong shape", async () => {
    expect(await check(null)).toBe("The X-Hub-Signature-256 header is missing");
    expect(await check(hmac(SECRET, body))).toBe("The X-Hub-Signature-256 header is missing");
    expect(await check(`sha1=${hmac(SECRET, body)}`)).toBe("The X-Hub-Signature-256 header is missing");
    expect(await check("sha256=")).toBe("The signature doesn't match");
    expect(await check(`sha256=${hmac(SECRET, body).slice(0, 62)}`)).toBe("The signature doesn't match");
    expect(await check(`sha256=${"zz".repeat(32)}`)).toBe("The signature doesn't match");
    expect(await check(`sha256=${hmac(SECRET, body)}00`)).toBe("The signature doesn't match");
  });

  it("checks the exact bytes, including an empty body", async () => {
    expect(await check(`sha256=${hmac(SECRET, "")}`, "")).toBeNull();
    expect(await check(`sha256=${hmac(SECRET, body)}`, `${body}\n`)).toBe("The signature doesn't match");
  });
});

describe("Stripe signatures", () => {
  const now = 1_800_000_000_000;
  const t = Math.floor(now / 1000);
  const sig = (time: number, payload = body, secret = SECRET) => hmac(secret, `${time}.${payload}`);
  const check = (header: string | null, payload = body, at = now) =>
    signatureProblem("stripe", SECRET, new Headers(header === null ? {} : { "stripe-signature": header }), bytes(payload), at);

  it("accepts the right signature at the signed time", async () => {
    expect(await check(`t=${t},v1=${sig(t)}`)).toBeNull();
    // Spaces after commas and other schemes (v0) are tolerated.
    expect(await check(`t=${t}, v0=abc, v1=${sig(t)}`)).toBeNull();
  });

  it("accepts a call with several v1 signatures when one of them is right", async () => {
    expect(await check(`t=${t},v1=${sig(t, body, "old-secret")},v1=${sig(t)}`)).toBeNull();
    expect(await check(`t=${t},v1=${sig(t)},v1=${"0".repeat(64)}`)).toBeNull();
    expect(await check(`t=${t},v1=${sig(t, body, "old-secret")},v1=${"0".repeat(64)}`)).toBe("The signature doesn't match");
  });

  it("refuses a wrong secret, a changed body, or a signature over another time", async () => {
    expect(await check(`t=${t},v1=${sig(t, body, "another-secret")}`)).toBe("The signature doesn't match");
    expect(await check(`t=${t},v1=${sig(t)}`, body.replace("opened", "closed"))).toBe("The signature doesn't match");
    expect(await check(`t=${t},v1=${sig(t - 1)}`)).toBe("The signature doesn't match");
    expect(await check(`t=${t},v1=nothex`)).toBe("The signature doesn't match");
  });

  it("accepts a time up to 300 seconds away and refuses one further off, in the past or the future", async () => {
    expect(await check(`t=${t - 300},v1=${sig(t - 300)}`)).toBeNull();
    expect(await check(`t=${t + 300},v1=${sig(t + 300)}`)).toBeNull();
    expect(await check(`t=${t - 301},v1=${sig(t - 301)}`)).toBe("The signature is too old");
    expect(await check(`t=${t + 301},v1=${sig(t + 301)}`)).toBe("The signature is too old");
  });

  it("refuses a missing or incomplete header", async () => {
    const incomplete = "The Stripe-Signature header is missing or incomplete";
    expect(await check(null)).toBe(incomplete);
    expect(await check(`v1=${sig(t)}`)).toBe(incomplete);
    expect(await check(`t=${t}`)).toBe(incomplete);
    expect(await check(`t=soon,v1=${sig(t)}`)).toBe(incomplete);
    expect(await check(`t=-${t},v1=${sig(t)}`)).toBe(incomplete);
  });
});
