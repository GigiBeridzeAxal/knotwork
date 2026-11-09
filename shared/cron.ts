/**
 * Five-field cron (minute hour day-of-month month day-of-week), evaluated in UTC.
 * Supports `*`, numbers, ranges `a-b`, steps `* /n` and `a-b/n`, and lists `a,b,c`.
 * Day of week is 0–6 with Sunday as 0 (7 also means Sunday).
 */

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

function parseField(text: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Can't read the ${name} field "${text}"`);
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo;
    }
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) {
      throw new Error(`The ${name} field "${text}" is out of range (${min}–${max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("A schedule needs five fields: minute hour day month weekday");
  const [minute, hour, dom, month, dow] = parts.map((p, i) =>
    parseField(p, FIELDS[i].min, FIELDS[i].max, FIELDS[i].name),
  );
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

export function cronMatches(cron: Cron, date: Date): boolean {
  if (!cron.minute.has(date.getUTCMinutes())) return false;
  if (!cron.hour.has(date.getUTCHours())) return false;
  if (!cron.month.has(date.getUTCMonth() + 1)) return false;
  const domOk = cron.dom.has(date.getUTCDate());
  const dowOk = cron.dow.has(date.getUTCDay());
  // Classic cron: when both day fields are restricted, either one matching is enough.
  if (!cron.domAny && !cron.dowAny) return domOk || dowOk;
  return domOk && dowOk;
}

export function validateCron(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** The shortest gap, in minutes, between two runs of a schedule within an hour. */
export function minutesBetweenRuns(expr: string): number {
  const minutes = [...parseCron(expr).minute].sort((a, b) => a - b);
  if (minutes.length === 1) return 60;
  let gap = 60 - minutes[minutes.length - 1] + minutes[0];
  for (let i = 1; i < minutes.length; i++) gap = Math.min(gap, minutes[i] - minutes[i - 1]);
  return gap;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

/**
 * The first minute after `after` (ms) that the schedule fires, or null if it never does within a
 * year (e.g. "0 0 31 2 *"). Walks days, then hours, then minutes, so it stays cheap.
 */
export function nextFire(cron: Cron, after: number): number | null {
  const start = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  const hours = [...cron.hour].sort((a, b) => a - b);
  const minutes = [...cron.minute].sort((a, b) => a - b);
  const firstDay = Math.floor(start / DAY) * DAY;
  for (let day = firstDay; day < firstDay + 367 * DAY; day += DAY) {
    const date = new Date(day);
    if (!cron.month.has(date.getUTCMonth() + 1)) continue;
    const domOk = cron.dom.has(date.getUTCDate());
    const dowOk = cron.dow.has(date.getUTCDay());
    const dayOk = !cron.domAny && !cron.dowAny ? domOk || dowOk : domOk && dowOk;
    if (!dayOk) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const at = day + h * 3_600_000 + m * MINUTE;
        if (at >= start) return at;
      }
    }
  }
  return null;
}
