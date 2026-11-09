/**
 * Knotwork is open to anyone who signs up, so every account gets limits that keep one person from
 * using up the free plans (Cloudflare Workers and the MongoDB Atlas M0 cluster) for everyone else.
 */
export const LIMITS = {
  workspacesPerAccount: 5,
  workflowsPerWorkspace: 10,
  stepsPerWorkflow: 25,
  /** Runs started in the last hour, counted across all of an account's workspaces. */
  runsPerAccountPerHour: 60,
  /** Runs started in the last hour across every account. The real ceiling for a free cluster. */
  runsPerHourOverall: 1500,
  minScheduleMinutes: 5,
  /** Runs (and their logs) are deleted this many days after they start. */
  runHistoryDays: 14,
  /** New accounts from one IP address per hour, and from everyone per day. */
  signupsPerIpPerHour: 5,
  signupsPerDay: 300,
  /** Wrong passwords for one email from one IP address in 15 minutes before logins are paused. */
  failedLoginsPer15Min: 10,
} as const;
