import { type Collection, type Db, MongoClient } from "mongodb";
import type { ApiKeyAccess, LogStatus, MemberRole, RunStatus, Step, Trigger, WorkflowInput } from "../shared/schema";

export interface Env {
  /** mongodb+srv://… for the Atlas cluster. A Wrangler secret in production, `.dev.vars` locally. */
  MONGODB_URI: string;
  /** Database name inside the cluster. Set in wrangler.jsonc; `npm run db:setup` reads the same name. */
  MONGODB_DB?: string;
  /** A long random secret mixed into every password hash. A Wrangler secret; `.dev.vars` locally. */
  AUTH_PEPPER: string;
  /** Cloudflare's rate-limiting binding: a per-IP request budget checked before any database work. */
  IP_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** A looser per-IP limit for /hooks, which many senders share addresses for. */
  HOOK_IP_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** Per-network (IPv6 /48) limits: for /api, and a looser one for /hooks. */
  NET_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  HOOK_NET_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  ASSETS: Fetcher;
  /**
   * The Durable Object that runs the API and the cron tick on one long-lived database connection
   * (worker/hub.ts). Without it (the tests), each request opens its own connection.
   */
  HUB?: DurableObjectNamespace;
  /** Set to any value to run without the hub (`wrangler deploy --var HUB_OFF:1`): the way back if the hub is the problem. */
  HUB_OFF?: string;
  /** Set only inside the hub: the connection it keeps open across requests. */
  SHARED_MONGO?: Mongo;
}

// ---------- Documents ----------

export interface UserDoc {
  _id: string;
  name: string;
  email: string;
  /** PBKDF2-SHA-256 of the peppered password. Null for the demo account, which only the demo button opens. */
  password: { hash: string; salt: string; iterations: number } | null;
  demo: boolean;
  createdAt: number;
  /**
   * Unused recovery codes, each stored as HMAC-SHA-256(pepper, user id and code), so neither the
   * database alone nor another account's codes can be used to get in. Using one removes it.
   */
  recoveryCodes?: string[];
}

export interface SessionDoc {
  /** SHA-256 of the cookie token, so a database leak doesn't leak working sessions. */
  _id: string;
  userId: string;
  demo: boolean;
  /**
   * The workspaces the user owns, copied here so one lookup authorizes a request. Workspaces they
   * joined are not in it: membership and role are read from `members` on every request, so a removed
   * member or a changed role takes effect at once.
   */
  workspaceIds: string[];
  createdAt: number;
  expiresAt: Date;
}

export interface WorkspaceDoc {
  _id: string;
  ownerId: string;
  name: string;
  personal: boolean;
  createdAt: number;
}

/** Someone who joined another account's workspace. The owner has no row: `workspaces.ownerId` says who it is. */
export interface MemberDoc {
  /** `<workspace id>:<user id>`, so a person is in a workspace at most once and the check is one lookup by id. */
  _id: string;
  workspaceId: string;
  userId: string;
  /** The workspace's owner, copied here: runs and limits are charged to them. */
  ownerId: string;
  role: MemberRole;
  createdAt: number;
}

export interface InviteDoc {
  /** SHA-256 of the token in the invite link, so a database leak doesn't leak working links. */
  _id: string;
  workspaceId: string;
  ownerId: string;
  role: MemberRole;
  uses: number;
  maxUses: number;
  /** The accounts that joined with it. A link lets each account in once (see `acceptInvite`). */
  joined: string[];
  createdAt: number;
  /** A TTL index deletes the invite at this time; the code also checks it. */
  expiresAt: Date;
}

export interface ApiKeyDoc {
  /** SHA-256 of the key, so a database leak doesn't leak working keys. Also its id in lists. */
  _id: string;
  userId: string;
  workspaceId: string;
  /** The workspace's owner. When it is `userId`, the key's maker owns the workspace. */
  ownerId: string;
  name: string;
  access: ApiKeyAccess;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface WorkflowDoc extends WorkflowInput {
  _id: string;
  workspaceId: string;
  ownerId: string;
  hookKey: string;
  version: number;
  /** Minute (ms) the schedule last fired, so a minute never fires twice. */
  lastScheduledAt: number | null;
  /** Next minute (ms) the schedule fires; null or missing means "work it out on the next tick". */
  nextFireAt?: number | null;
  /** `error: "space"` when the storage guard stopped it. */
  lastRun: { id: string; status: RunStatus; createdAt: number; error?: string } | null;
  createdAt: number;
  updatedAt: number;
}

/** A run log line. It keeps a short preview of the step's output; the full output is in `outputs`. */
export interface LogDoc {
  id: number;
  stepId: string;
  stepName: string;
  stepType: Step["type"];
  attempt: number;
  status: LogStatus;
  message: string | null;
  output: unknown;
  startedAt: number;
  durationMs: number;
}

export interface RunDoc {
  _id: string;
  workflowId: string;
  workflowName: string;
  workspaceId: string;
  ownerId: string;
  status: RunStatus;
  triggerType: Trigger["type"];
  input: unknown;
  /** The steps as they were when the run started. */
  steps: Step[];
  /** Each finished step's output, by step id. Set one key at a time, never rewritten whole. */
  outputs: Record<string, unknown>;
  outputBytes: number;
  stepIndex: number;
  attempt: number;
  /** Claims in a row that ended without saving progress. Too many and the run is failed. */
  claims: number;
  nextRunAt: number | null;
  leaseUntil: number | null;
  error: string | null;
  logs: LogDoc[];
  createdAt: number;
  finishedAt: number | null;
  /** A TTL index deletes the run at this time, finished or not. */
  expiresAt: Date;
}

/**
 * One saved version of a workflow, kept so an earlier version can be looked at or loaded back. The id
 * is the workflow id and version number, so saving the same version twice writes one document.
 */
export interface VersionDoc {
  _id: string;
  workflowId: string;
  workspaceId: string;
  ownerId: string;
  version: number;
  /** When this version was saved (ms). */
  savedAt: number;
  /** JSON length of `workflow`, so pruning can keep a workflow's history under its byte limit. */
  bytes: number;
  workflow: WorkflowInput;
}

export interface CounterDoc {
  _id: string;
  n: number;
  expiresAt: Date;
}

export interface Collections {
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  workspaces: Collection<WorkspaceDoc>;
  workflows: Collection<WorkflowDoc>;
  runs: Collection<RunDoc>;
  counters: Collection<CounterDoc>;
  versions: Collection<VersionDoc>;
  members: Collection<MemberDoc>;
  invites: Collection<InviteDoc>;
  apiKeys: Collection<ApiKeyDoc>;
}

export function collections(db: Db): Collections {
  return {
    users: db.collection("users"),
    sessions: db.collection("sessions"),
    workspaces: db.collection("workspaces"),
    workflows: db.collection("workflows"),
    runs: db.collection("runs"),
    counters: db.collection("counters"),
    versions: db.collection("versions"),
    members: db.collection("members"),
    invites: db.collection("invites"),
    apiKeys: db.collection("apiKeys"),
  };
}

/**
 * A database connection, opened on first use. A Worker can't keep a socket from one request for the
 * next, and opening one (TLS, then SCRAM) costs far more CPU than the free plan's 10 ms per request,
 * so in production one Durable Object (worker/hub.ts) keeps a single Mongo open across requests.
 * Without the hub, each request makes its own and closes it when done.
 */
export class Mongo {
  private client: MongoClient | null = null;
  private cols: Collections | null = null;
  private database: Db | null = null;

  private env: Env;
  /** When the client was made, and when its first connection was ready (ms): for Server-Timing. */
  started = 0;
  connected = 0;

  /** A shared connection (the hub's) serves requests that overlap, so it may use two sockets. */
  private shared: boolean;
  /** Set by close(). A closed Mongo never reconnects, so nothing can open a client that nobody closes. */
  closed = false;
  /** Set when a request found this client finished (see clientIsDead); the hub then replaces it. */
  broken = false;
  /** When connection errors began with nothing working since (ms), or 0. See clientIsDead. */
  failingSince = 0;

  constructor(env: Env, { shared = false } = {}) {
    this.env = env;
    this.shared = shared;
  }

  get c(): Collections {
    if (this.closed) throw new Error("This database connection is closed");
    if (!this.cols) {
      if (!this.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
      this.client = new MongoClient(this.env.MONGODB_URI, {
        // One pooled connection per request (two in the hub): each extra one costs a TLS and SCRAM
        // handshake, and a Worker may only hold six sockets open at once (the monitors take three).
        maxPoolSize: this.shared ? 2 : 1,
        // "stream" would add a second socket per server after 10 s; polling keeps one.
        serverMonitoringMode: "poll",
        serverSelectionTimeoutMS: 8_000,
        connectTimeoutMS: 8_000,
        // A socket that hangs, or a queue behind two busy sockets, becomes an error instead of a
        // request that waits for ever. No query here should take anywhere near this long.
        socketTimeoutMS: 20_000,
        waitQueueTimeoutMS: 10_000,
        appName: "knotwork",
      });
      this.started = Date.now();
      this.client.once("connectionReady", () => (this.connected = Date.now()));
      // A new pooled connection got through: whatever was failing has ended.
      this.client.on("connectionReady", () => (this.failingSince = 0));
      this.database = this.client.db(this.env.MONGODB_DB || "knotwork");
      this.cols = collections(this.database);
    }
    return this.cols;
  }

  /** The database itself, for commands such as `dbStats`. */
  get db(): Db {
    void this.c;
    return this.database!;
  }

  async close() {
    this.closed = true;
    const client = this.client;
    this.client = null;
    this.cols = null;
    this.database = null;
    await client?.close().catch(() => {});
  }
}

const CONNECTION_ERRORS = new Set([
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoServerSelectionError",
  "MongoNotConnectedError",
  "MongoTopologyClosedError",
  "MongoPoolClearedError",
]);

/** Errors a client never recovers from: it has been closed, or it never connected. */
const DEAD_CLIENT_ERRORS = new Set(["MongoTopologyClosedError", "MongoNotConnectedError"]);

const named = (err: unknown, names: Set<string>): boolean => {
  for (let e = err as { name?: string; cause?: unknown } | undefined, depth = 0; e && depth < 4; e = e.cause as typeof e, depth++) {
    if (e.name && names.has(e.name)) return true;
  }
  return false;
};

/** How long a connected client may fail with connection errors only before it is given up on. */
const STUCK_MS = 180_000;

/**
 * True when this error means the client itself is finished and a new one is needed. A network error
 * on a client that has connected before is not that: the driver reconnects on its own, and a second
 * client opened during an outage is the one that can't recover (its first connect fails and it stays
 * closed). A client that never connected and fails to is finished.
 *
 * The last resort: a connected client that has had nothing but connection errors for STUCK_MS is
 * finished too, in case the driver can't repair it. This call notes when the errors began
 * (`failingSince`); a new connection getting through, or a tick that worked, clears it.
 */
export function clientIsDead(mongo: Mongo, err: unknown, now = Date.now()): boolean {
  if (named(err, DEAD_CLIENT_ERRORS)) return true;
  if (!named(err, CONNECTION_ERRORS)) return false;
  if (mongo.connected === 0) return true;
  if (!mongo.failingSince) mongo.failingSince = now;
  return now - mongo.failingSince >= STUCK_MS;
}

/** True when the database couldn't be reached or was too busy to answer in time: a 503, not a bug. */
export function databaseUnavailable(err: unknown): boolean {
  return named(err, CONNECTION_ERRORS) || named(err, new Set(["MongoWaitQueueTimeoutError"]));
}

/** True for errors that mean the connection itself failed, as opposed to a bug or a refused write. */
export function isConnectionError(err: unknown): boolean {
  return named(err, CONNECTION_ERRORS);
}

/**
 * Every index the app relies on. Run once with `npm run db:setup` (and again after adding one).
 * Returns the ones the server refused, e.g. TTL indexes on a MongoDB-compatible test server.
 */
export async function ensureIndexes(c: Collections): Promise<string[]> {
  const results = await Promise.allSettled([
    c.users.createIndex({ email: 1 }, { unique: true }),
    c.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.sessions.createIndex({ userId: 1 }),
    c.workspaces.createIndex({ ownerId: 1, personal: -1, createdAt: 1 }),
    c.workflows.createIndex({ workspaceId: 1, updatedAt: -1 }),
    c.workflows.createIndex({ hookKey: 1 }, { unique: true }),
    c.workflows.createIndex({ "trigger.type": 1, enabled: 1, nextFireAt: 1 }),
    c.runs.createIndex({ workspaceId: 1, createdAt: -1 }),
    c.runs.createIndex({ workflowId: 1, createdAt: -1 }),
    c.runs.createIndex({ status: 1, createdAt: 1 }),
    c.runs.createIndex({ status: 1, nextRunAt: 1, ownerId: 1 }),
    c.runs.createIndex({ ownerId: 1, status: 1, nextRunAt: 1 }),
    c.runs.createIndex({ ownerId: 1, status: 1, createdAt: -1 }),
    c.runs.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.counters.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.versions.createIndex({ workflowId: 1, version: -1 }),
    c.members.createIndex({ userId: 1, createdAt: 1 }),
    c.members.createIndex({ workspaceId: 1, createdAt: 1 }),
    c.members.createIndex({ ownerId: 1 }),
    c.invites.createIndex({ workspaceId: 1, createdAt: 1 }),
    c.invites.createIndex({ ownerId: 1 }),
    c.invites.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.apiKeys.createIndex({ userId: 1, createdAt: 1 }),
    c.apiKeys.createIndex({ workspaceId: 1 }),
    c.apiKeys.createIndex({ ownerId: 1 }),
  ]);
  // Indexes that newer ones above replaced. Dropping one that isn't there is fine.
  await Promise.allSettled([c.runs.dropIndex("status_1_nextRunAt_1"), c.workflows.dropIndex("trigger.type_1_enabled_1")]);
  return results.flatMap((r) => (r.status === "rejected" ? [(r.reason as Error).message] : []));
}

/**
 * How deeply JSON from a client or a step may be nested. MongoDB refuses documents nested more than
 * 100 levels, and a workflow's step, a run's input or a step's output sits a few levels inside its
 * document.
 */
export const MAX_JSON_DEPTH = 50;

/**
 * Why a parsed JSON value can't be stored, or "" when it can: nested more than `max` levels, or an
 * object key with a null byte (the database driver refuses those). No recursion: the input may be
 * very deep.
 */
export function unstorable(value: unknown, max = MAX_JSON_DEPTH): string {
  let level: unknown[] = [value];
  for (let depth = 0; level.length; depth++) {
    const next: unknown[] = [];
    for (const item of level) {
      if (!item || typeof item !== "object") continue;
      if (depth >= max) return `That JSON is nested more than ${max} levels deep`;
      if (Array.isArray(item)) {
        for (const child of item) next.push(child);
      } else {
        for (const [key, child] of Object.entries(item)) {
          if (key.includes("\u0000")) return "A field name contains a null character";
          next.push(child);
        }
      }
    }
    level = next;
  }
  return "";
}

export function randomId(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const newUserId = () => `usr_${randomId(9)}`;
export const newWorkspaceId = () => `ws_${randomId(12)}`;
export const newWorkflowId = () => `wf_${randomId(8)}`;
export const newRunId = () => `run_${randomId(10)}`;
export const memberId = (workspaceId: string, userId: string) => `${workspaceId}:${userId}`;
