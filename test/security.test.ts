import { describe, expect, it } from "vitest";
import { render, renderText, TemplateTooLarge } from "../shared/template";
import { cookieName, hashPassword, ipKey, readCookie, sessionCookie, verifyPassword } from "../worker/auth";
import { keepable } from "../worker/engine";
import { DEMO_HOSTS, executeStep, privateHost } from "../worker/steps";

const PEPPER = "test-pepper-0123456789abcdef";

describe("passwords", () => {
  it("verifies the right password and rejects others", async () => {
    const stored = await hashPassword("correct horse battery", PEPPER);
    expect(stored.iterations).toBe(10_000);
    expect(stored.hash).not.toContain("correct");
    expect(await verifyPassword("correct horse battery", stored, PEPPER)).toBe(true);
    expect(await verifyPassword("correct horse batterY", stored, PEPPER)).toBe(false);
    expect(await verifyPassword("anything", null, PEPPER)).toBe(false);
  });

  it("needs the pepper: the database alone can't check a password", async () => {
    const stored = await hashPassword("correct horse battery", PEPPER);
    expect(await verifyPassword("correct horse battery", stored, "another-pepper-0123456789")).toBe(false);
    await expect(hashPassword("correct horse battery", "short")).rejects.toThrow(/AUTH_PEPPER/);
  });

  it("salts every hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same password", PEPPER), hashPassword("same password", PEPPER)]);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("rate-limit keys", () => {
  it("group an IPv6 network by its /64, so one machine can't rotate through addresses", () => {
    expect(ipKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("2001:db8:1:2:aaaa::1", 48)).toBe("2001:db8:1::/48");
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

  it("is a __Host- cookie on https, so other subdomains can't set or read it", () => {
    expect(sessionCookie("tok", true)).toMatch(/^__Host-kw_session=tok; Path=\/;/);
    expect(cookieName(false)).toBe("kw_session");
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
    expect(JSON.stringify(keepable({ text: "x".repeat(5_000) }, 1_000).value).length).toBeLessThan(1_100);
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
    const blocked = [
      "localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "[::1]", "fd00::1",
      "metadata.internal", "[::ffff:7f00:1]", "[::7f00:1]", "[64:ff9b::a00:1]", "[2002:a00:1::1]", "[fec0::1]", "[fe80::1]",
    ];
    for (const host of blocked) expect(privateHost(host), host).toBe(true);
    // Hosts as the URL parser hands them over, so mapped forms are normalised the same way.
    expect(privateHost(new URL("http://[::ffff:127.0.0.1]/").hostname)).toBe(true);
    for (const host of ["api.github.com", "8.8.8.8", "172.32.0.1", "[2606:4700::1111]"]) {
      expect(privateHost(host), host).toBe(false);
    }
  });

  it("from the demo account only call the allowed hosts", async () => {
    const step = { id: "a", name: "Call", type: "http" as const, retry: { max: 0, backoffSeconds: 5 }, config: { method: "GET" as const, url: "https://evil.example.net/x", headers: {}, failOnError: true } };
    const scope = { trigger: null, steps: {}, run: { id: "r", startedAt: "" }, workflow: { id: "w", name: "w" }, secrets: {} };
    const result = await executeStep(step, scope, { allowHosts: DEMO_HOSTS });
    expect(result).toMatchObject({ kind: "fail", message: expect.stringMatching(/demo account can only call/) });
  });
});

describe("templates", () => {
  it("fail fast instead of building megabytes when one big value is named many times", () => {
    const scope = { trigger: { text: "x".repeat(60_000) } };
    const started = performance.now();
    expect(() => renderText("{{trigger}}".repeat(2_900), scope)).toThrow(TemplateTooLarge);
    expect(() => render({ a: Array(2_900).fill("{{ trigger }}") }, scope)).toThrow(TemplateTooLarge);
    expect(performance.now() - started).toBeLessThan(200);
    // Within the budget, rendering works as before.
    expect(renderText("{{ trigger.text }}!", { trigger: { text: "hi" } })).toBe("hi!");
  });

  it("make a step fail with a clear message, not crash", async () => {
    const step = { id: "a", name: "Log", type: "log" as const, retry: { max: 0, backoffSeconds: 5 }, config: { message: "{{trigger}}".repeat(181) } };
    const scope = { trigger: "y".repeat(60_000), steps: {}, run: { id: "r", startedAt: "" }, workflow: { id: "w", name: "w" }, secrets: {} };
    await expect(executeStep(step, scope)).rejects.toThrow(/more than 64 KB/);
  });

  it("stay fast on input built to make regexes backtrack", () => {
    const evil = "{{" + " ".repeat(20_000) + "x";
    const started = performance.now();
    renderText(evil, {});
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("webhook keys", () => {
  const pepper = "test-pepper-0123456789abcdef";

  it("accepts keys it signed and refuses made-up or altered ones", async () => {
    const { hookKeyValid, newHookKey } = await import("../worker/auth");
    const key = await newHookKey(pepper);
    expect(key).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(await hookKeyValid(key, pepper)).toBe(true);
    expect(await hookKeyValid(key, "another-pepper-0123456789")).toBe(false);
    const flipped = key.slice(0, 5) + (key[5] === "A" ? "B" : "A") + key.slice(6);
    expect(await hookKeyValid(flipped, pepper)).toBe(false);
    expect(await hookKeyValid("A".repeat(24), pepper)).toBe(false);
    expect(await hookKeyValid("short", pepper)).toBe(false);
  });
});
