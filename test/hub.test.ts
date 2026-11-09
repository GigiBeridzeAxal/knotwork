import { describe, expect, it, vi } from "vitest";
import worker, { nestedDeeperThan } from "../worker/index";
import { Hub } from "../worker/hub";
import { newHookKey } from "../worker/hookKey";
import { type Env, isConnectionError, Mongo } from "../worker/mongo";

/**
 * The hub's connection handling, and what the Worker does around the hub. No database is needed:
 * the API and the tick are replaced by stand-ins, and a Mongo that never runs a query never connects.
 */
const env = { MONGODB_URI: "mongodb://127.0.0.1:1/none", AUTH_PEPPER: "test-pepper-0123456789abcdef", ASSETS: {} } as unknown as Env;

type Handle = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

class TestHub extends Hub {
  pending: Promise<unknown>[] = [];
  constructor() {
    const pending: Promise<unknown>[] = [];
    super({ waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as DurableObjectState, env);
    this.pending = pending;
  }
  set handle(fn: Handle) {
    this.work.handle = fn as typeof this.work.handle;
  }
  set tick(fn: () => Promise<void>) {
    this.work.tick = fn as unknown as typeof this.work.tick;
  }
  /** The connection new requests would get. */
  get current(): Mongo {
    return (this as unknown as { conn: { mongo: Mongo } }).conn.mongo;
  }
}

const get = (hub: Hub) => hub.fetch(new Request("https://kw.test/api/health"));
const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((done) => (open = done));
  return { wait, open };
};
const networkError = () => Object.assign(new Error("socket closed"), { name: "MongoNetworkError" });

describe("Hub connection", () => {
  it("keeps its connection when a request answers 500 for another reason", async () => {
    const hub = new TestHub();
    const first = hub.current;
    hub.handle = async () => Response.json({ error: "bug" }, { status: 500 });
    expect((await get(hub)).status).toBe(500);
    expect(hub.current).toBe(first);
    expect(first.closed).toBe(false);
  });

  it("replaces the connection once when several requests fail on it together", async () => {
    const hub = new TestHub();
    const first = hub.current;
    const seen = new Set<Mongo>();
    const g = gate();
    hub.handle = async (_request, e) => {
      await g.wait;
      e.SHARED_MONGO!.broken = true;
      return Response.json({ error: "down" }, { status: 500 });
    };
    const calls = [1, 2, 3, 4, 5].map(() => get(hub).then(() => seen.add(hub.current)));
    g.open();
    await Promise.all(calls);
    expect(hub.current).not.toBe(first);
    // Every failed request saw the same replacement: one new connection, not five.
    expect(seen.size).toBe(1);
    expect(first.closed).toBe(true);
    expect(hub.current.closed).toBe(false);
  });

  it("lets a request and its background work finish on a replaced connection before closing it", async () => {
    const hub = new TestHub();
    const first = hub.current;
    const slow = gate();
    const background = gate();
    let used: Mongo | undefined;
    hub.handle = async (_request, e, ctx) => {
      ctx.waitUntil(background.wait);
      await slow.wait;
      used = e.SHARED_MONGO;
      return new Response("ok");
    };
    const long = get(hub);
    hub.handle = async (_request, e) => {
      e.SHARED_MONGO!.broken = true;
      return new Response(null, { status: 500 });
    };
    await get(hub);
    expect(hub.current).not.toBe(first);
    expect(first.closed).toBe(false);
    slow.open();
    expect((await long).status).toBe(200);
    expect(used).toBe(first);
    // The response is out, but the run it started is still using the old connection.
    expect(first.closed).toBe(false);
    background.open();
    await Promise.all(hub.pending);
    expect(first.closed).toBe(true);
  });

  it("replaces the connection when the tick fails with a connection error, and not for other errors", async () => {
    const hub = new TestHub();
    const first = hub.current;
    const tick = () => hub.fetch(new Request("https://hub.internal/__hub/tick", { method: "POST" }));
    hub.tick = async () => {
      throw new TypeError("bug in a step");
    };
    expect((await tick()).status).toBe(204);
    expect(hub.current).toBe(first);
    hub.tick = async () => {
      throw networkError();
    };
    expect((await tick()).status).toBe(204);
    expect(hub.current).not.toBe(first);
    expect(first.closed).toBe(true);
  });

  it("replaces the connection at most once in 30 seconds, however often requests fail", async () => {
    const hub = new TestHub();
    const first = hub.current;
    hub.handle = async (_request, e) => {
      e.SHARED_MONGO!.broken = true;
      return new Response(null, { status: 500 });
    };
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(1_000_000);
      await get(hub);
      const second = hub.current;
      expect(second).not.toBe(first);
      clock.mockReturnValue(1_000_000 + 29_000);
      await get(hub);
      await get(hub);
      expect(hub.current).toBe(second);
      clock.mockReturnValue(1_000_000 + 31_000);
      await get(hub);
      expect(hub.current).not.toBe(second);
      expect(second.closed).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("only answers the tick on its internal address", async () => {
    const hub = new TestHub();
    let ticks = 0;
    hub.tick = async () => void ticks++;
    hub.handle = async () => new Response("api");
    await hub.fetch(new Request("https://kw.test/__hub/tick", { method: "POST" }));
    await hub.fetch(new Request("https://hub.internal/__hub/tick"));
    expect(ticks).toBe(0);
  });
});

describe("Mongo", () => {
  it("stays closed: using it after close() throws instead of opening a new client", async () => {
    const mongo = new Mongo(env);
    void mongo.c;
    await mongo.close();
    expect(() => mongo.c).toThrow("closed");
    expect(() => mongo.db).toThrow("closed");
  });

  it("tells connection errors from other errors, also when wrapped", () => {
    expect(isConnectionError(networkError())).toBe(true);
    expect(isConnectionError(new Error("outer", { cause: networkError() }))).toBe(true);
    expect(isConnectionError(new TypeError("x is undefined"))).toBe(false);
    expect(isConnectionError(Object.assign(new Error("dup"), { name: "MongoServerError", code: 11000 }))).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
  });
});

describe("Worker in front of the hub", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const withHub = (fetch: (request: Request) => Promise<Response>, extra: Partial<Env> = {}) =>
    ({ ...env, ...extra, HUB: { idFromName: () => "main", get: () => ({ fetch }) } }) as unknown as Env;
  const request = (path: string, ip = "203.0.113.9") => new Request(`https://kw.test${path}`, { headers: { "cf-connecting-ip": ip } });

  it("forwards API and webhook paths to the hub", async () => {
    const paths: string[] = [];
    const e = withHub(async (r) => {
      paths.push(new URL(r.url).pathname);
      return new Response("hub");
    });
    const key = await newHookKey(env.AUTH_PEPPER);
    await worker.fetch(request("/api/health") as never, e, ctx);
    await worker.fetch(request(`/hooks/${key}`) as never, e, ctx);
    expect(paths).toEqual(["/api/health", `/hooks/${key}`]);
  });

  it("answers 503 JSON when the hub can't be reached", async () => {
    const e = withHub(async () => {
      throw new Error("Exceeded allowed duration in Durable Objects free tier.");
    });
    const res = await worker.fetch(request("/api/me") as never, e, ctx);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(((await res.json()) as { error: string }).error).toMatch(/Try again/);
  });

  it("turns a rate-limited request away without calling the hub", async () => {
    let calls = 0;
    const e = withHub(async () => (calls++, new Response("hub")), { IP_LIMITER: { limit: async () => ({ success: false }) } });
    const res = await worker.fetch(request("/api/me") as never, e, ctx);
    expect(res.status).toBe(429);
    expect(calls).toBe(0);
  });

  it("refuses a made-up webhook key without calling the hub", async () => {
    let calls = 0;
    const e = withHub(async () => (calls++, new Response("hub")));
    const res = await worker.fetch(new Request(`https://kw.test/hooks/${"x".repeat(24)}`, { method: "POST" }) as never, e, ctx);
    expect(res.status).toBe(404);
    expect(calls).toBe(0);
  });

  it("runs without the hub when HUB_OFF is set", async () => {
    let calls = 0;
    const e = withHub(async () => (calls++, new Response("hub")), { HUB_OFF: "1" });
    const res = await worker.fetch(request("/api/health") as never, e, ctx);
    expect(res.status).toBe(200);
    expect(calls).toBe(0);
  });
});

describe("JSON depth", () => {
  const nest = (levels: number) => {
    let value: unknown = 1;
    for (let i = 0; i < levels; i++) value = i % 2 ? [value] : { a: value };
    return value;
  };

  it("allows 50 levels and refuses 51, without recursing", () => {
    expect(nestedDeeperThan(nest(50))).toBe(false);
    expect(nestedDeeperThan(nest(51))).toBe(true);
    expect(nestedDeeperThan(nest(100_000))).toBe(true);
    expect(nestedDeeperThan("text")).toBe(false);
    expect(nestedDeeperThan({ wide: Array.from({ length: 1000 }, (_, i) => ({ i })) })).toBe(false);
  });
});
