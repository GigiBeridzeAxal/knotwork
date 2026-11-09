/**
 * Knotwork is open to anyone who signs up, so every account gets limits that keep one person from
 * using up the free plans (Cloudflare Workers and the MongoDB Atlas M0 cluster) for everyone else.
 * Sizes are in bytes of JSON.
 */
export const LIMITS = {
  workspacesPerAccount: 5,
  workflowsPerWorkspace: 10,
  /** Counting the steps inside if and loop blocks. */
  stepsPerWorkflow: 25,
  /** How deep steps can nest: 1 is the top level, so 3 allows a block inside a block. */
  stepDepth: 3,
  /** Items one loop goes through. A longer list fails the step instead of being cut short. */
  loopItems: 50,
  /**
   * Steps one run may run in total. Every time a step runs counts: each pass of a loop, each retry,
   * each "if" check and each start of a loop. Moving a loop to its next item does not.
   */
  stepRunsPerRun: 200,
  /**
   * Requests to other sites one run makes before it steps aside until the next minute, and the most
   * all the runs woken in one minute make together. Cloudflare's free plan allows 50 outgoing requests
   * per invocation; redirects use some of them too.
   */
  httpCallsPerGo: 30,
  httpCallsPerTick: 40,
  secretsPerWorkspace: 20,
  secretMinChars: 8,
  secretMaxChars: 4_000,
  /** How far a Stripe webhook's signed time may be from now (seconds). */
  signatureToleranceSeconds: 300,
  /** A saved workflow (its trigger and every step's settings). */
  workflowBytes: 32_000,
  /** Test input for a manual run, and a webhook's body. */
  runInputBytes: 64_000,
  /** Runs started this clock hour, counted across all of an account's workspaces. */
  runsPerAccountPerHour: 60,
  /** The same for an account in its first 24 hours. */
  newAccountRunsPerHour: 10,
  /**
   * What runs may store per clock hour (input, steps, outputs, logs): per account; for webhook and
   * manual runs together; for scheduled runs; and, past half of either pool, per account.
   */
  runBytesPerAccountPerHour: 4_000_000,
  runBytesPerHourOverall: 60_000_000,
  scheduleRunBytesPerHour: 30_000_000,
  fairShareRunBytesPerHour: 200_000,
  /** Runs one account can have queued or waiting (in a delay or retry) at once. */
  pendingRunsPerAccount: 100,
  /** Webhook and manual runs started this clock hour across every account (schedules don't count). */
  runsPerHourOverall: 3_000,
  /** Once half of that is used, accounts that have started more than this many this hour must wait. */
  fairShareRunsPerHour: 20,
  minScheduleMinutes: 5,
  /** Runs (and their logs) are deleted this many days after they start, or after their last wait. */
  runHistoryDays: 7,
  /** New accounts from one IP address (or IPv6 /48) per hour, and from everyone per day. */
  signupsPerIpPerHour: 5,
  signupsPerDay: 300,
  /** Login attempts for one email from one IP address in 15 minutes. */
  loginAttemptsPer15Min: 10,
  /** Demo sign-ins from one IP (or IPv6 /48) per hour. */
  demoLoginsPerIpPerHour: 30,
  /** Requests to the API and webhooks from one IP per minute, checked before any database work. */
  requestsPerIpPerMinute: 60,
  /** Sign-ups with an email that already has an account, per network per hour (stops probing). */
  duplicateSignupsPerHour: 10,
  /** Sessions one account can have at once; logging in again drops the oldest. */
  sessionsPerAccount: 20,
} as const;
