import { describe, expect, it } from "vitest";
import { renderText } from "../shared/template";
import { hashPassword, readCookie, sessionCookie, verifyPassword } from "../worker/auth";
import { keepable } from "../worker/engine";
import { privateHost } from "../worker/steps";

describe("passwords", () => {
  it("verifies the right password and rejects others", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored.iterations).toBe(100_000);
    expect(stored.hash).not.toContain("correct");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterY", stored)).toBe(false);
    expect(await verifyPassword("anything", null)).toBe(false);
  });

  it("salts every hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same password"), hashPassword("same password")]);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("session cookie", () => {
  it("is HttpOnly, SameSite=Lax and Secure on https", () => {
    const cookie = sessionCookie("tok", true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(sessionCookie("tok", false)).not.toContain("Secure");
  });

  it("is read back from a cookie header", () => {
    expect(readCookie("a=1; kw_session=abc; b=2", "kw_session")).toBe("abc");
    expect(readCookie(undefined, "kw_session")).toBe("");
  });
});

describe("step outputs", () => {
  it("keeps a value that contains itself as a note instead of throwing", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const kept = keepable(loop);
    expect(kept.value).toMatchObject({ unsaved: true });
  });

  it("cuts very large outputs", () => {
    const kept = keepable({ text: "x".repeat(50_000) });
    expect(kept.value).toMatchObject({ truncated: true });
  });

  it("copies values, so later steps can't change what was kept", () => {
    const original = { a: [1] };
    const kept = keepable(original).value as { a: number[] };
    original.a.push(2);
    expect(kept.a).toEqual([1]);
  });
});

describe("http steps", () => {
  it("refuse private and local addresses", () => {
    for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "[::1]", "fd00::1", "metadata.internal"]) {
      expect(privateHost(host), host).toBe(true);
    }
    for (const host of ["api.github.com", "8.8.8.8", "172.32.0.1", "[2606:4700::1111]"]) {
      expect(privateHost(host), host).toBe(false);
    }
  });
});

describe("templates", () => {
  it("stay fast on input built to make regexes backtrack", () => {
    const evil = "{{" + " ".repeat(20_000) + "x";
    const started = performance.now();
    renderText(evil, {});
    expect(performance.now() - started).toBeLessThan(100);
  });
});
