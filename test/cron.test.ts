import { describe, expect, it } from "vitest";
import { cronMatches, parseCron, validateCron } from "../shared/cron";

const at = (iso: string) => new Date(iso);

describe("cron", () => {
  it("matches common schedules", () => {
    expect(cronMatches(parseCron("0 * * * *"), at("2026-11-07T15:00:00Z"))).toBe(true);
    expect(cronMatches(parseCron("0 * * * *"), at("2026-11-07T15:01:00Z"))).toBe(false);
    expect(cronMatches(parseCron("*/5 * * * *"), at("2026-11-07T15:35:00Z"))).toBe(true);
    expect(cronMatches(parseCron("*/5 * * * *"), at("2026-11-07T15:36:00Z"))).toBe(false);
    expect(cronMatches(parseCron("0 9 * * 1-5"), at("2026-11-09T09:00:00Z"))).toBe(true); // Monday
    expect(cronMatches(parseCron("0 9 * * 1-5"), at("2026-11-08T09:00:00Z"))).toBe(false); // Sunday
    expect(cronMatches(parseCron("0 0 * * 7"), at("2026-11-08T00:00:00Z"))).toBe(true); // 7 is Sunday too
  });

  it("uses either day field when both are set", () => {
    const cron = parseCron("0 0 1 * 1");
    expect(cronMatches(cron, at("2026-12-01T00:00:00Z"))).toBe(true); // the 1st
    expect(cronMatches(cron, at("2026-11-09T00:00:00Z"))).toBe(true); // a Monday
    expect(cronMatches(cron, at("2026-11-10T00:00:00Z"))).toBe(false);
  });

  it("explains bad expressions", () => {
    expect(validateCron("* * *")).toMatch(/five fields/);
    expect(validateCron("61 * * * *")).toMatch(/out of range/);
    expect(validateCron("a * * * *")).toMatch(/Can't read/);
    expect(validateCron("15,45 8-18/2 * * *")).toBeNull();
  });
});

describe("schedule spacing", () => {
  it("finds the shortest gap between runs", async () => {
    const { minutesBetweenRuns } = await import("../shared/cron");
    expect(minutesBetweenRuns("* * * * *")).toBe(1);
    expect(minutesBetweenRuns("*/5 * * * *")).toBe(5);
    expect(minutesBetweenRuns("0 * * * *")).toBe(60);
    expect(minutesBetweenRuns("0,58 * * * *")).toBe(2);
  });
});

describe("next fire time", () => {
  it("finds the next minute a schedule fires", async () => {
    const { nextFire } = await import("../shared/cron");
    const iso = (expr: string, from: string) => {
      const t = nextFire(parseCron(expr), Date.parse(from));
      return t === null ? null : new Date(t).toISOString();
    };
    expect(iso("*/5 * * * *", "2026-11-07T15:35:00Z")).toBe("2026-11-07T15:40:00.000Z");
    expect(iso("0 9 * * 1", "2026-11-09T09:00:00Z")).toBe("2026-11-16T09:00:00.000Z");
    expect(iso("0 0 1 * 1", "2026-11-09T00:00:00Z")).toBe("2026-11-16T00:00:00.000Z");
    expect(iso("30 23 31 12 *", "2026-11-09T00:00:00Z")).toBe("2026-12-31T23:30:00.000Z");
    expect(iso("0 0 30 2 *", "2026-11-09T00:00:00Z")).toBeNull();
  });

  it("agrees with cronMatches minute by minute", async () => {
    const { nextFire } = await import("../shared/cron");
    const start = Date.parse("2026-11-07T22:13:00Z");
    for (const expr of ["*/7 * * * *", "15,45 8-18/2 * * *", "0 0 1 * 1", "5 4 * * 0", "*/20 3 * * 2-4"]) {
      const cron = parseCron(expr);
      let expected = start + 60_000;
      while (!cronMatches(cron, new Date(expected))) expected += 60_000;
      expect(nextFire(cron, start), expr).toBe(expected);
    }
  });
});
