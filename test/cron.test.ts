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
