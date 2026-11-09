import { describe, expect, it } from "vitest";
import { LEFT_OUT, trimSample, versionsToDrop } from "../worker/db";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("pruning version history", () => {
  const list = (sizes: number[]) => sizes.map((b, i) => ({ _id: `wf:${sizes.length - i}`, bytes: b }));

  it("keeps the newest ones up to the count", () => {
    expect(versionsToDrop(list(Array(20).fill(100)))).toEqual([]);
    expect(versionsToDrop(list(Array(23).fill(100)))).toEqual(["wf:3", "wf:2", "wf:1"]);
  });

  it("drops the oldest ones while the kept ones are over the byte limit", () => {
    // 50 + 40 = 90 fit in 100; the third (30) would not, so it and everything older go.
    expect(versionsToDrop(list([50, 40, 30, 5]), 20, 100)).toEqual(["wf:2", "wf:1"]);
  });

  it("always keeps the newest version, however big", () => {
    expect(versionsToDrop(list([500, 10]), 20, 100)).toEqual(["wf:1"]);
    expect(versionsToDrop([], 20, 100)).toEqual([]);
  });
});

describe("trimming sample data", () => {
  it("leaves small samples alone", () => {
    expect(trimSample({ body: { a: 1 } }, { s: 1 }, 1_000)).toEqual({ trigger: { body: { a: 1 } }, steps: { s: 1 }, trimmed: false });
    expect(trimSample(undefined, {}, 1_000)).toEqual({ trigger: null, steps: {}, trimmed: false });
  });

  it("leaves out the largest outputs first, until the rest fit", () => {
    const steps = { small: "s".repeat(100), big: "b".repeat(5_000), mid: "m".repeat(3_000) };
    const res = trimSample({ n: 1 }, steps, 4_000);
    expect(res.trimmed).toBe(true);
    expect(res.steps).toEqual({ small: steps.small, big: LEFT_OUT, mid: steps.mid });
    expect(bytes({ trigger: res.trigger, steps: res.steps })).toBeLessThanOrEqual(4_000);
    // Both big ones go when only the small one fits.
    expect(trimSample({ n: 1 }, steps, 1_000).steps).toEqual({ small: steps.small, big: LEFT_OUT, mid: LEFT_OUT });
  });

  it("leaves out a trigger that alone is too large, and keeps the outputs", () => {
    const res = trimSample({ body: "x".repeat(10_000) }, { a: { ok: true } }, 2_000);
    expect(res).toEqual({ trigger: LEFT_OUT, steps: { a: { ok: true } }, trimmed: true });
  });

  it("counts UTF-8 bytes, not characters", () => {
    const res = trimSample(null, { a: "é".repeat(600) }, 1_000);
    expect(res.steps.a).toBe(LEFT_OUT);
  });

  it("stays under the default limit for a big run", () => {
    const steps = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`s${i}`, "y".repeat(2_500)]));
    const res = trimSample({ body: "t".repeat(30_000) }, steps);
    expect(bytes({ trigger: res.trigger, steps: res.steps })).toBeLessThanOrEqual(32_000);
    expect(Object.keys(res.steps)).toHaveLength(25);
  });
});
