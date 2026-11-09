import { type Collection, type Db, MongoClient } from "mongodb";
import type { LogStatus, RunStatus, Step, Trigger, WorkflowInput } from "../shared/schema";

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
   * (worker/hub.ts). Without it (tests, plain `vite dev`), each request opens its own connection.
   */
  HUB?: DurableObjectNamespace;
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
}

export interface SessionDoc {
  /** SHA-256 of the cookie token, so a database leak doesn't leak working sessions. */
  _id: string;
  userId: string;
  demo: boolean;
  /** The user's workspaces, copied here so one lookup authorizes a request. */
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
  depth?: number;
  pass?: string;
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
  /** Where the run is: an index into the steps flattened by worker/program.ts. */
  stepIndex: number;
  attempt: number;
  /** Steps run so far, counting every pass of every loop (missing on runs from before loops). */
  stepRuns?: number;
  /** The run this one repeats ("Run again"). */
  rerunOf?: string;
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

/** A workspace secret. `_id` is `<workspaceId>:<name>`; the value is encrypted (worker/secrets.ts). */
export interface SecretDoc {
  _id: string;
  workspaceId: string;
  ownerId: string;
  name: string;
  /** AES-GCM nonce and ciphertext, base64. */
  iv: string;
  data: string;
  createdAt: number;
  updatedAt: number;
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
  secrets: Collection<SecretDoc>;
  counters: Collection<CounterDoc>;
}

export function collections(db: Db): Collections {
  return {
    users: db.collection("users"),
    sessions: db.collection("sessions"),
    workspaces: db.collection("workspaces"),
    workflows: db.collection("workflows"),
    runs: db.collection("runs"),
    secrets: db.collection("secrets"),
    counters: db.collection("counters"),
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

  constructor(env: Env, { shared = false } = {}) {
    this.env = env;
    this.shared = shared;
  }

  get c(): Collections {
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
        appName: "knotwork",
      });
      this.started = Date.now();
      this.client.once("connectionReady", () => (this.connected = Date.now()));
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
    const client = this.client;
    this.client = null;
    this.cols = null;
    this.database = null;
    await client?.close().catch(() => {});
  }
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
    c.secrets.createIndex({ workspaceId: 1, name: 1 }),
    c.secrets.createIndex({ ownerId: 1 }),
  ]);
  // Indexes that newer ones above replaced. Dropping one that isn't there is fine.
  await Promise.allSettled([c.runs.dropIndex("status_1_nextRunAt_1"), c.workflows.dropIndex("trigger.type_1_enabled_1")]);
  return results.flatMap((r) => (r.status === "rejected" ? [(r.reason as Error).message] : []));
}

export function randomId(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const newUserId = () => `usr_${randomId(9)}`;
export const newWorkspaceId = () => `ws_${randomId(12)}`;
export const newWorkflowId = () => `wf_${randomId(8)}`;
export const newRunId = () => `run_${randomId(10)}`;
