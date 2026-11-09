/**
 * Knotwork is open to anyone who signs up, so every account gets limits that keep one person from
 * using up the free plans (Cloudflare Workers and the MongoDB Atlas M0 cluster) for everyone else.
 * Sizes are in bytes of JSON.
 */
export const LIMITS = {
  workspacesPerAccount: 5,
  workflowsPerWorkspace: 10,
  stepsPerWorkflow: 25,
  /** A saved workflow (its trigger and every step's settings). */
  workflowBytes: 32_000,
  /** Test input for a manual run, and a webhook's body. */
  runInputBytes: 64_000,
  /** Runs started this clock hour, counted across all of an account's workspaces. */
  runsPerAccountPerHour: 60,
  /** The same for an account in its first 24 hours. */
  newAccountRunsPerHour: 10,
  /** What new runs may store (input and steps) per clock hour: per account, overall, and the fair share past half. */
  runBytesPerAccountPerHour: 4_000_000,
  runBytesPerHourOverall: 60_000_000,
  fairShareRunBytesPerHour: 1_000_000,
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
