import { handle, HUB_TICK } from "./index";
import { tick } from "./engine";
import { clientIsDead, type Env, Mongo } from "./mongo";

const REPLACE_GAP_MS = 30_000;
/** The wait before replacing a connection that never got through (the database was down when it was made). */
const RETRY_GAP_MS = 5_000;
/** A replaced connection is closed after this long even if something still counts as using it. */
const RETIRED_MAX_MS = 120_000;

/** A connection and how many requests and background jobs are still using it. */
interface Conn {
  mongo: Mongo;
  busy: number;
  /** Replaced by a newer one: close it as soon as nothing uses it. */
  retired: boolean;
}

/**
 * One Durable Object that runs the API, the webhooks and the cron tick on a single database
 * connection it keeps open between requests.
 *
 * Opening a MongoDB connection (DNS, TLS, then SCRAM) takes about 30 to 90 ms of CPU and over a
 * second of wall time; a plain Worker would pay that on every request, three to nine times the free
 * plan's 10 ms. A Durable Object can keep sockets across requests, so only its first request after
 * it starts (a deploy, or Cloudflare moving it) pays it; the cron tick every minute keeps it in
 * memory. It is placed in western Europe, next to the cluster, so each query is a short round trip.
 */
export class Hub {
  private conn: Conn;
  private env: Env;
  private state: DurableObjectState;
  /** When the connection was last replaced (ms), so a burst of failures can't open one after another. */
  private replacedAt = 0;
  /** What the hub runs; a field so tests can replace it. */
  protected work = { handle, tick };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.conn = this.open();
  }

  private open(): Conn {
    return { mongo: new Mongo(this.env, { shared: true }), busy: 0, retired: false };
  }

  async fetch(request: Request): Promise<Response> {
    const conn = this.conn;
    // Counts a piece of work against the connection it started on, until it settles either way.
    const hold = <T>(work: Promise<T>): Promise<T> => {
      conn.busy++;
      return work.finally(() => this.release(conn));
    };
    if (request.url === HUB_TICK && request.method === "POST") {
      try {
        await hold(this.work.tick(conn.mongo.c, Date.now(), conn.mongo.db, this.env.AUTH_PEPPER));
        // Every tick starts with a query, so one that worked means the database is answering.
        conn.mongo.failingSince = 0;
      } catch (err) {
        console.error("tick", err);
        if (clientIsDead(conn.mongo, err)) this.replace(conn);
      }
      return new Response(null, { status: 204 });
    }
    const ctx = {
      // Background work (a run started by this request) keeps using the connection after the response.
      waitUntil: (p: Promise<unknown>) => this.state.waitUntil(hold(Promise.resolve(p)).catch(() => {})),
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    const res = await hold(
      Promise.resolve(this.work.handle(request, { ...this.env, HUB: undefined, SHARED_MONGO: conn.mongo }, ctx)),
    );
    // Only a finished client is replaced (the API marks it). A bug that answers 500 doesn't replace
    // it, and neither does a network error on a client that has connected: the driver repairs that,
    // unless nothing has worked for three minutes (clientIsDead's last resort).
    if (conn.mongo.broken) this.replace(conn);
    return res;
  }

  /**
   * Starts a new connection for later requests: once however many requests failed on the old one,
   * and at most once in REPLACE_GAP_MS, because every new connection costs Atlas sockets and a
   * handshake. A connection that never got through is retried sooner (RETRY_GAP_MS), so the hub
   * is back within seconds of the database returning.
   */
  private replace(conn: Conn) {
    if (this.conn !== conn) return;
    const now = Date.now();
    if (now - this.replacedAt < (conn.mongo.connected ? REPLACE_GAP_MS : RETRY_GAP_MS)) return;
    this.replacedAt = now;
    this.conn = this.open();
    conn.retired = true;
    if (conn.busy === 0) void conn.mongo.close();
    // A request Cloudflare cancelled might never count itself out. Closing is safe either way: a
    // closed connection throws when used, and closing twice does nothing.
    else setTimeout(() => void conn.mongo.close(), RETIRED_MAX_MS);
  }

  /** A replaced connection closes when the last request or background job on it has finished. */
  private release(conn: Conn) {
    conn.busy--;
    if (conn.retired && conn.busy === 0) void conn.mongo.close();
  }
}
