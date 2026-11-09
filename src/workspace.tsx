import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import type { Run, WorkflowSummary } from "../shared/schema";
import { LIMITS } from "../shared/limits";
import { api, ApiError } from "./api";
import { useSession } from "./session";

interface WorkspaceData {
  workflows: WorkflowSummary[] | null;
  /** The newest 100 runs. That covers more than an hour and a half at the hourly limit. */
  runs: Run[] | null;
  /** Runs the whole account started this clock hour; the hourly limit counts these. */
  runsThisHour: number;
  /** The account's hourly run limit (lower in its first day). */
  runsLimit: number;
  error: string;
  refresh: () => void;
}

const Ctx = createContext<WorkspaceData>({ workflows: null, runs: null, runsThisHour: 0, runsLimit: LIMITS.runsPerAccountPerHour, error: "", refresh: () => {} });

/**
 * Loads the current workspace once for the sidebar and the home page, and refreshes it every
 * 30 seconds while the tab is visible. Mounted with the workspace id as its key, so switching
 * workspaces starts from empty instead of showing the old one's lists.
 */
export function WorkspaceProvider({ path, children }: { path: string; children: ReactNode }) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [runsThisHour, setRunsThisHour] = useState(0);
  const [runsLimit, setRunsLimit] = useState<number>(LIMITS.runsPerAccountPerHour);
  const [error, setError] = useState("");
  const { reload, workspace } = useSession();
  const role = workspace.role;

  const refresh = useCallback(() => {
    api.overview().then(
      (o) => {
        setWorkflows(o.workflows);
        setRuns(o.runs);
        setRunsThisHour(o.runsThisHour);
        setRunsLimit(o.runsLimit);
        setError("");
        // The owner changed this person's role while the app was open: pick it up without a page reload.
        if (o.role !== role) reload().catch(() => {});
      },
      (e: Error) => {
        // The workspace was deleted, or this person was removed from it: reload the list, which falls back to Personal.
        if (e instanceof ApiError && e.status === 404) reload("").catch(() => setError(e.message));
        else setError(e.message);
      },
    );
  }, [reload, role]);

  useEffect(refresh, [refresh, path]);
  useEffect(() => {
    const timer = setInterval(() => document.visibilityState === "visible" && refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return <Ctx.Provider value={{ workflows, runs, runsThisHour, runsLimit, error, refresh }}>{children}</Ctx.Provider>;
}

export const useWorkspace = () => useContext(Ctx);

export const HOUR = 3_600_000;
export const runsSince = (runs: Run[] | null, ms: number) => (runs ?? []).filter((r) => r.createdAt >= Date.now() - ms);
