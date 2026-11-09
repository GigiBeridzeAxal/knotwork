import { handle, HUB_TICK } from "./index";
import { tick } from "./engine";
import { ensureIndexes, type Env, Mongo } from "./mongo";

/**
 * One Durable Object that runs the API, the webhooks and the cron tick on a single database
 * connection it keeps open between requests.
 *
 * Opening a MongoDB connection (DNS, TLS, then SCRAM) takes about 30 to 90 ms of CPU and over a
 * second of wall time; a plain Worker would pay that on every request, three to nine times the free
 * plan's 10 ms. A Durable Object can keep sockets across requests, so only its first request (after
 * it starts, or after a minute or two idle) pays it. It is placed in western Europe, next to the
 * cluster, so each query is a short round trip.
 */
export class Hub {
  private mongo: Mongo;
  private env: Env;
  private state: DurableObjectState;
  /** Whether this instance has made sure the database's indexes exist (see `fetch`). */
  private indexed = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.mongo = new Mongo(env, { shared: true });
  }

  async fetch(request: Request): Promise<Response> {
    const ctx = {
      waitUntil: (p: Promise<unknown>) => this.state.waitUntil(p),
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    if (request.url === HUB_TICK && request.method === "POST") {
      // Once per start of the hub: create any index a newer version added (`createIndex` does nothing
      // for one that exists), so a deploy that adds collections needs no `npm run db:setup` by hand.
      if (!this.indexed) {
        this.indexed = true;
        this.state.waitUntil(
          ensureIndexes(this.mongo.c).then(
            (failed) => failed.length && console.warn("indexes", failed),
            () => (this.indexed = false),
          ),
        );
      }
      try {
        await tick(this.mongo.c, Date.now(), this.mongo.db, this.env.AUTH_PEPPER);
      } catch (err) {
        console.error("tick", err);
        await this.reset();
      }
      return new Response(null, { status: 204 });
    }
    const res = await handle(request, { ...this.env, HUB: undefined, SHARED_MONGO: this.mongo }, ctx);
    // An unexpected error may mean the connection broke; start a fresh one for the next request.
    if (res.status === 500) await this.reset();
    return res;
  }

  /** Swaps in a new connection; the old one closes after requests still using it have finished. */
  private async reset() {
    const old = this.mongo;
    this.mongo = new Mongo(this.env, { shared: true });
    this.state.waitUntil(new Promise((done) => setTimeout(done, 30_000)).then(() => old.close()));
  }
}
