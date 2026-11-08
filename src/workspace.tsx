import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import type { Run, WorkflowSummary } from "../shared/schema";
import { api } from "./api";

interface WorkspaceData {
  workflows: WorkflowSummary[] | null;
  /** The newest 200 runs. That covers more than three hours at the hourly limit. */
  runs: Run[] | null;
  error: string;
  refresh: () => void;
}

const Ctx = createContext<WorkspaceData>({ workflows: null, runs: null, error: "", refresh: () => {} });

/** Loads the workspace once for the sidebar and the home page, and refreshes it every 10 seconds. */
export function WorkspaceProvider({ path, children }: { path: string; children: ReactNode }) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    Promise.all([api.workflows(), api.runs(undefined, 200)]).then(
      ([w, r]) => {
        setWorkflows(w);
        setRuns(r);
        setError("");
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  useEffect(refresh, [refresh, path]);
  useEffect(() => {
    const timer = setInterval(() => document.visibilityState === "visible" && refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return <Ctx.Provider value={{ workflows, runs, error, refresh }}>{children}</Ctx.Provider>;
}

export const useWorkspace = () => useContext(Ctx);

export const HOUR = 3_600_000;
export const runsSince = (runs: Run[] | null, ms: number) => (runs ?? []).filter((r) => r.createdAt >= Date.now() - ms);
