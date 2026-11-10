/**
 * Keeps one browser tab under the request limit Cloudflare enforces in front of the API: more than
 * 10 requests to /api/ in 10 seconds from one address and the address is blocked for 10 seconds
 * (README, "Deploy"). Opening a few pages quickly used to pass that, and every request then failed
 * with 429 until the block ended.
 *
 * Requests take a turn before they are sent. A turn is free while fewer than BUDGET went out in the
 * last 11 seconds; after that it waits for the oldest one to leave the window. Background requests
 * (polling) stop two short of the budget, so a click never has to wait behind a refresh.
 */

/** The rule's own window. */
export const RULE_WINDOW_MS = 10_000;
/**
 * How long a sent request keeps its place: the rule's 10 seconds plus one. Requests don't arrive
 * at Cloudflare exactly as far apart as they left, so without the extra second the tenth could
 * land in the same 10 seconds as the first nine.
 */
export const WINDOW_MS = RULE_WINDOW_MS + 1000;
/** One under the rule, because Cloudflare counts arrivals and this counts departures. */
export const BUDGET = 9;
export const BACKGROUND_BUDGET = 7;

interface Waiting {
  background: boolean;
  go: () => void;
}

export interface Pacer {
  /** Resolves when the request may be sent. */
  turn(background?: boolean): Promise<void>;
  /** Sends nothing for this long: the server said it is refusing requests from this address. */
  pause(ms: number): void;
}

/**
 * `load` and `save` keep the send times across a page reload (reloading several times in a row
 * counts toward the same limit); both are optional and may throw. `unlimited` gives every turn at
 * once and only honours `pause`: for local development, where Cloudflare's rule doesn't exist.
 */
export function createPacer(store: { load?: () => number[]; save?: (sent: number[]) => void; unlimited?: boolean } = {}): Pacer {
  let sent: number[] = [];
  try {
    sent = (store.load?.() ?? []).filter((t) => Number.isFinite(t) && t <= Date.now()).sort((a, b) => a - b);
  } catch {
    // Nothing remembered: start with a full budget.
  }
  let pausedUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Waiting[] = [];

  function pump() {
    clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    sent = sent.filter((t) => t > now - WINDOW_MS);
    let wait = pausedUntil - now;
    if (wait <= 0) {
      while (queue.length) {
        // People first: whatever was asked for by a click goes before any background refresh.
        const index = Math.max(0, queue.findIndex((w) => !w.background));
        const next = queue[index];
        const budget = store.unlimited ? Infinity : next.background ? BACKGROUND_BUDGET : BUDGET;
        if (sent.length >= budget) {
          wait = sent[sent.length - budget] + WINDOW_MS - now;
          break;
        }
        queue.splice(index, 1);
        sent.push(now);
        next.go();
      }
      try {
        store.save?.(sent);
      } catch {
        // Storage is blocked: the budget just starts full after a reload.
      }
    }
    if (queue.length) timer = setTimeout(pump, Math.max(wait, 0) + 1);
  }

  return {
    turn(background = false) {
      return new Promise<void>((go) => {
        queue.push({ background, go });
        pump();
      });
    },
    pause(ms) {
      pausedUntil = Math.max(pausedUntil, Date.now() + ms);
    },
  };
}

/** How long a refused request waits before its one more try when the answer doesn't say. */
export const BLOCK_MS = 10_000;
/** A wait longer than this isn't worth holding a page for: the person is told instead. */
const LONGEST_WAIT_MS = 15_000;

/**
 * For a 429: how long to wait before sending the same request again, or null when it should not be
 * retried.
 *
 * Two kinds of 429 are safe to send again, because the request never reached Knotwork's code:
 * Cloudflare's block (its own page, not Knotwork's JSON) and Knotwork's per-address limit when it
 * names a short wait. Every other 429 is a real limit (runs per hour, wrong passwords, sign-ups)
 * with a message the person has to see.
 */
export function retryAfter(ours: boolean, header: string | null): number | null {
  const seconds = Number(header);
  const named = header !== null && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  if (!ours) return Math.min(named ?? BLOCK_MS, LONGEST_WAIT_MS);
  return named !== null && named <= LONGEST_WAIT_MS ? named : null;
}
