import { describe, expect, it } from "vitest";
import { redactor, seal, secretRefs, unseal } from "../worker/secrets";

/** Secrets without a database: which ones a workflow names, hiding their values, and sealing them. */

describe("secret references", () => {
  it("finds the secret names templates mention anywhere in a value", () => {
    const refs = secretRefs({
      url: "https://hooks.example.com/{{ secrets.SLACK_URL }}",
      headers: { authorization: "Bearer {{secrets.API_TOKEN}}" },
      body: ["{{ secrets.SLACK_URL }}", { deep: "x {{  secrets.OTHER_1 }} y" }],
      n: 3,
      none: null,
    });
    expect([...refs].sort()).toEqual(["API_TOKEN", "OTHER_1", "SLACK_URL"]);
  });

  it("ignores text that only looks a bit like a reference", () => {
    expect(secretRefs(["{{ secrets }}", "{{ secret.A }}", "secrets.A", "{{ steps.secrets.A }}"]).size).toBe(0);
  });

  it("adds to a set it is given", () => {
    const into = new Set(["A"]);
    secretRefs("{{ secrets.B }}", into);
    expect([...into]).toEqual(["A", "B"]);
  });
});

describe("redactor", () => {
  it("replaces a value wherever it appears, in strings and keys, without changing the original", () => {
    const clean = redactor({ API_KEY: "sk_live_12345" });
    const value = { a: "token sk_live_12345 twice sk_live_12345", list: [1, "sk_live_12345", { sk_live_12345: true }], n: 5, b: null };
    expect(clean(value)).toEqual({
      a: "token [secret API_KEY] twice [secret API_KEY]",
      list: [1, "[secret API_KEY]", { "[secret API_KEY]": true }],
      n: 5,
      b: null,
    });
    expect(value.a).toBe("token sk_live_12345 twice sk_live_12345");
  });

  it("also replaces the value as it looks inside JSON text and URL-encoded", () => {
    const secret = 'pa"ss/wo\\rd&x=1';
    const clean = redactor({ PASS: secret });
    expect(clean(JSON.stringify({ p: secret }))).toBe('{"p":"[secret PASS]"}');
    expect(clean(`https://x.test/?p=${encodeURIComponent(secret)}`)).toBe("https://x.test/?p=[secret PASS]");
    expect(clean(`raw ${secret}`)).toBe("raw [secret PASS]");
  });

  it("replaces a secret that contains another one whole", () => {
    const clean = redactor({ SHORT: "abcdefgh", LONG: "abcdefgh-and-more" });
    expect(clean("abcdefgh-and-more / abcdefgh")).toBe("[secret LONG] / [secret SHORT]");
  });

  it("passes values through untouched when there is nothing to hide", () => {
    const value = { a: "x" };
    expect(redactor({})(value)).toBe(value);
    expect(redactor({ EMPTY: "" })("nothing here")).toBe("nothing here");
  });
});

describe("sealing", () => {
  const key = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) as Promise<CryptoKey>;

  it("opens what it sealed, and the stored form doesn't contain the value", async () => {
    const k = await key();
    const sealed = await seal(k, "ws_a", "API_KEY", "sk_live_12345");
    expect(JSON.stringify(sealed)).not.toContain("sk_live_12345");
    expect(atob(sealed.data)).not.toContain("sk_live_12345");
    expect(await unseal(k, "ws_a", "API_KEY", sealed)).toBe("sk_live_12345");
  });

  it("uses a fresh nonce each time", async () => {
    const k = await key();
    const a = await seal(k, "ws_a", "API_KEY", "same-value");
    const b = await seal(k, "ws_a", "API_KEY", "same-value");
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("refuses to open a value moved to another name or workspace, or with another key", async () => {
    const k = await key();
    const sealed = await seal(k, "ws_a", "API_KEY", "sk_live_12345");
    await expect(unseal(k, "ws_a", "OTHER_KEY", sealed)).rejects.toThrow();
    await expect(unseal(k, "ws_b", "API_KEY", sealed)).rejects.toThrow();
    await expect(unseal(await key(), "ws_a", "API_KEY", sealed)).rejects.toThrow();
  });

  it("refuses a value whose ciphertext was changed", async () => {
    const k = await key();
    const sealed = await seal(k, "ws_a", "API_KEY", "sk_live_12345");
    const bytes = Uint8Array.from(atob(sealed.data), (ch) => ch.charCodeAt(0));
    bytes[0] ^= 1;
    await expect(unseal(k, "ws_a", "API_KEY", { iv: sealed.iv, data: btoa(String.fromCharCode(...bytes)) })).rejects.toThrow();
  });
});
