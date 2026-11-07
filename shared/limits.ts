/**
 * Knotwork is open to anyone, so each workspace gets limits that keep one visitor from using up the
 * Cloudflare free plan for everybody else.
 */
export const LIMITS = {
  workflowsPerWorkspace: 10,
  stepsPerWorkflow: 25,
  runsPerWorkspacePerHour: 60,
  minScheduleMinutes: 5,
  /** Workflows that nobody edits or runs for this many days are deleted. */
  idleWorkflowDays: 30,
} as const;
