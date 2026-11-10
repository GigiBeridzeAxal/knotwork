import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_BUDGET, BLOCK_MS, BUDGET, createPacer, retryAfter, WINDOW_MS } from "../src/pace";

/**
 * The dashboard's request pacing: one tab must never send more than Cloudflare's rule in front of
 * the API allows (10 requests in 10 seconds), however fast pages are opened.
 */
describe("request pacing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  /** Asks for `count` turns and records when each one is given. */
  function ask(pacer: ReturnType<typeof createPacer>, count: number, background = false) {
    const given: number[] = [];
    for (let i = 0; i < count; i++) pacer.turn(background).then(() => given.push(Date.now()));
    return given;
  }
  /** The most turns given inside any 10 second window. */
  const worst = (times: number[]) => Math.max(...times.map((a) => times.filter((b) => b >= a && b < a + WINDOW_MS).length));

  it("sends a normal page's requests at once", async () => {
    const given = ask(createPacer(), 5);
    await vi.advanceTimersByTimeAsync(0);
    expect(given).toHaveLength(5);
    expect(new Set(given)).toEqual(new Set([1_000_000]));
  });

  it("never gives more than the budget in any 10 seconds, and loses none", async () => {
    const pacer = createPacer();
    const given = ask(pacer, 20);
    await vi.advanceTimersByTimeAsync(3000);
    // A second burst while the first is still waiting.
    const more = ask(pacer, 15);
    await vi.advanceTimersByTimeAsync(60_000);
    const all = [...given, ...more].sort((a, b) => a - b);
    expect(all).toHaveLength(35);
    expect(worst(all)).toBeLessThanOrEqual(BUDGET);
    expect(BUDGET).toBeLessThan(10);
  });

  it("lets a click go before background refreshes, and keeps two turns free for it", async () => {
    const pacer = createPacer();
    const polls = ask(pacer, BUDGET, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toHaveLength(BACKGROUND_BUDGET);
    // Two polls are waiting. A click made now is still sent at once.
    const clicks = ask(pacer, 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(clicks).toEqual([1_000_000, 1_000_000]);
    // A third click has to wait for the window, and then goes before the polls asked for earlier.
    const order: string[] = [];
    pacer.turn().then(() => order.push("click"));
    polls.length = 0;
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 5);
    expect(order).toEqual([]);
    pacer.turn(true).then(() => order.push("poll"));
    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual(["click", "poll"]);
    expect(polls).toHaveLength(BUDGET - BACKGROUND_BUDGET);
  });

  it("sends nothing while paused, then carries on", async () => {
    const pacer = createPacer();
    pacer.pause(BLOCK_MS);
    const given = ask(pacer, 3);
    await vi.advanceTimersByTimeAsync(BLOCK_MS - 100);
    expect(given).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(given).toHaveLength(3);
  });

  it("counts what was sent before a page reload", async () => {
    let stored: number[] = [];
    const store = { load: () => stored, save: (sent: number[]) => void (stored = sent) };
    const before = ask(createPacer(store), BUDGET - 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(before).toHaveLength(BUDGET - 1);
    // The reload: a new pacer that reads what the old one saved.
    const after = ask(createPacer(store), 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(after).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(WINDOW_MS + 5);
    expect(after).toHaveLength(3);
  });

  it("works when storage throws or holds rubbish", async () => {
    const broken = createPacer({
      load: () => {
        throw new Error("blocked");
      },
      save: () => {
        throw new Error("blocked");
      },
    });
    const rubbish = createPacer({ load: () => [Number.NaN, 9e15, "x" as unknown as number] });
    const fromBroken = ask(broken, 2);
    const fromRubbish = ask(rubbish, BUDGET);
    await vi.advanceTimersByTimeAsync(0);
    expect(fromBroken).toHaveLength(2);
    expect(fromRubbish).toHaveLength(BUDGET);
  });
});

describe("which 429 answers are sent again", () => {
  it("Cloudflare's block: after the time it names, or 10 seconds", () => {
    expect(retryAfter(false, null)).toBe(BLOCK_MS);
    expect(retryAfter(false, "4")).toBe(4000);
    expect(retryAfter(false, "nonsense")).toBe(BLOCK_MS);
    expect(retryAfter(false, "3600")).toBe(15_000);
  });
  it("Knotwork's own limits: only when the answer names a short wait", () => {
    // Runs per hour, wrong passwords, sign-ups: a message the person has to read.
    expect(retryAfter(true, null)).toBeNull();
    // The per-address limit names a minute, too long to hold a page for.
    expect(retryAfter(true, "60")).toBeNull();
    expect(retryAfter(true, "5")).toBe(5000);
  });
});

describe("without a limit (local development)", () => {
  it("gives every turn at once, but still waits out a pause", async () => {
    vi.useFakeTimers();
    try {
      const pacer = createPacer({ unlimited: true });
      let given = 0;
      for (let i = 0; i < 50; i++) pacer.turn(i % 2 === 0).then(() => given++);
      await vi.advanceTimersByTimeAsync(0);
      expect(given).toBe(50);
      pacer.pause(BLOCK_MS);
      pacer.turn().then(() => given++);
      await vi.advanceTimersByTimeAsync(BLOCK_MS - 100);
      expect(given).toBe(50);
      await vi.advanceTimersByTimeAsync(200);
      expect(given).toBe(51);
    } finally {
      vi.useRealTimers();
    }
  });
});
