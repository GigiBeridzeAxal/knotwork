import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import type { Run, WorkflowSummary } from "../shared/schema";
import { api } from "./api";

interface WorkspaceData {
  workflows: WorkflowSummary[] | null;
  /** The newest 200 runs. That covers more than three hours at the hourly limit. */
  runs: Run[] | null;
  /** Runs the whole account started in the last hour; the hourly limit counts these. */
  runsThisHour: number;
  error: string;
  refresh: () => void;
}

const Ctx = createContext<WorkspaceData>({ workflows: null, runs: null, runsThisHour: 0, error: "", refresh: () => {} });

/**
 * Loads the current workspace once for the sidebar and the home page, and refreshes it every
 * 15 seconds while the tab is visible. Mounted with the workspace id as its key, so switching
 * workspaces starts from empty instead of showing the old one's lists.
 */
export function WorkspaceProvider({ path, children }: { path: string; children: ReactNode }) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [runsThisHour, setRunsThisHour] = useState(0);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    api.overview().then(
      (o) => {
        setWorkflows(o.workflows);
        setRuns(o.runs);
        setRunsThisHour(o.runsThisHour);
        setError("");
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  useEffect(refresh, [refresh, path]);
  useEffect(() => {
    const timer = setInterval(() => document.visibilityState === "visible" && refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return <Ctx.Provider value={{ workflows, runs, runsThisHour, error, refresh }}>{children}</Ctx.Provider>;
}

export const useWorkspace = () => useContext(Ctx);

export const HOUR = 3_600_000;
export const runsSince = (runs: Run[] | null, ms: number) => (runs ?? []).filter((r) => r.createdAt >= Date.now() - ms);
