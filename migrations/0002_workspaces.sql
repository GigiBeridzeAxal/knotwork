-- Each visitor gets a private workspace (an id kept in their browser). Workflows made before this
-- change move to a "legacy" workspace nobody browses.
ALTER TABLE workflows ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX workflows_by_workspace ON workflows (workspace_id, updated_at DESC);
