-- Workflows: a trigger plus an ordered list of steps, stored as JSON.
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger TEXT NOT NULL,        -- JSON: { type: "manual" | "webhook" | "schedule", cron? }
  steps TEXT NOT NULL,          -- JSON: Step[]
  hook_key TEXT NOT NULL UNIQUE,
  last_scheduled_at INTEGER,    -- minute (ms) the schedule last fired, so a minute never fires twice
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Runs: one execution of a workflow. The engine moves a run forward one step at a time and saves
-- its place, so a run survives retries, delays and Worker restarts.
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status TEXT NOT NULL,         -- queued | running | waiting | succeeded | failed | stopped
  trigger_type TEXT NOT NULL,
  input TEXT NOT NULL,          -- JSON: what the trigger received
  steps TEXT NOT NULL,          -- JSON: the steps as they were when the run started
  context TEXT NOT NULL,        -- JSON: { steps: { [stepId]: output } }
  step_index INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER,          -- when a waiting run may continue
  lease_until INTEGER,          -- a running run belongs to one invocation until this time
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX runs_by_workflow ON runs (workflow_id, created_at DESC);
CREATE INDEX runs_due ON runs (status, next_run_at);

-- One row per step attempt: the run log.
CREATE TABLE step_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  step_name TEXT NOT NULL,
  step_type TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,         -- ok | failed | retrying | stopped | waiting
  message TEXT,
  output TEXT,                  -- JSON, trimmed to a safe size
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);
CREATE INDEX step_logs_by_run ON step_logs (run_id, id);
