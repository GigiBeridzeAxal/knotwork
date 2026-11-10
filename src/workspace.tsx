import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Run, WorkflowSummary } from "../shared/schema";
import { LIMITS } from "../shared/limits";
import { api, ApiError, whenChanged } from "./api";
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
  /** Loads the lists again now, behind anything a click asked for. */
  refresh: () => void;
}

const Ctx = createContext<WorkspaceData>({ workflows: null, runs: null, runsThisHour: 0, runsLimit: LIMITS.runsPerAccountPerHour, error: "", refresh: () => {} });

/** On a page change the lists are loaded again only when they are older than this, or something changed. */
const FRESH_MS = 10_000;
const LIST_PAGES = new Set(["/home", "/workflows", "/runs"]);

/**
 * Loads the current workspace once for the sidebar, the home page and the workflow and run lists,
 * and refreshes it every 30 seconds while the tab is visible. Mounted with the workspace id as its
 * key, so switching workspaces starts from empty instead of showing the old one's lists.
 *
 * It does not reload on every page change: with the pages' own requests that passed Cloudflare's
 * 10 requests in 10 seconds after a few clicks (src/pace.ts). A page change reloads it when a
 * workflow or run was just changed, when the page is one of the lists and they are more than 2
 * seconds old, or when they are more than 10 seconds old.
 */
export function WorkspaceProvider({ path, children }: { path: string; children: ReactNode }) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [runsThisHour, setRunsThisHour] = useState(0);
  const [runsLimit, setRunsLimit] = useState<number>(LIMITS.runsPerAccountPerHour);
  const [error, setError] = useState("");
  const { reload, workspace } = useSession();
  const role = workspace.role;
  /** When the lists were last asked for, and whether a workflow or run changed since. */
  const asked = useRef({ at: 0, changed: false });

  const load = useCallback(
    (background: boolean) => {
      asked.current = { at: Date.now(), changed: false };
      api.overview({ background }).then(
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
    },
    [reload, role],
  );
  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    const { at, changed } = asked.current;
    // The pages that are these lists get them fresh on every visit. Elsewhere they only feed the sidebar.
    const lists = LIST_PAGES.has(path);
    if (!at) load(false);
    // Only a list page just after the person changed something is worth making a click wait for.
    else if (changed || Date.now() - at > (lists ? 2000 : FRESH_MS)) load(!(changed && lists));
  }, [load, path]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    // A change that isn't followed by a page change (a save in the editor) still reaches the sidebar.
    whenChanged(() => {
      asked.current.changed = true;
      clearTimeout(timer);
      timer = setTimeout(() => asked.current.changed && load(true), 1500);
    });
    return () => {
      whenChanged(() => {});
      clearTimeout(timer);
    };
  }, [load]);
  useEffect(() => {
    const timer = setInterval(() => document.visibilityState === "visible" && Date.now() - asked.current.at > 25_000 && load(true), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  return <Ctx.Provider value={{ workflows, runs, runsThisHour, runsLimit, error, refresh }}>{children}</Ctx.Provider>;
}

export const useWorkspace = () => useContext(Ctx);

export const HOUR = 3_600_000;
export const runsSince = (runs: Run[] | null, ms: number) => (runs ?? []).filter((r) => r.createdAt >= Date.now() - ms);
