import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Me, Workspace } from "../shared/schema";
import { api, setCurrentWorkspace, whenSignedOut } from "./api";

type State = { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; me: Me; workspaceId: string };

interface SessionApi {
  state: State;
  /** The signed-in user's data; only use inside the app, where the user is known to be signed in. */
  me: Me;
  workspace: Workspace;
  signedIn: (me: Me) => void;
  logout: () => Promise<void>;
  switchWorkspace: (id: string) => void;
  /** Reloads the user and workspace list, e.g. after creating or renaming a workspace. */
  reload: (selectId?: string) => Promise<void>;
}

const Ctx = createContext<SessionApi | null>(null);

const LAST_KEY = "knotwork.lastWorkspace";
const remember = (userId: string, id: string) => {
  try {
    localStorage.setItem(`${LAST_KEY}.${userId}`, id);
  } catch {
    // Storage blocked: the app opens the personal workspace next time.
  }
};
const recall = (userId: string) => {
  try {
    return localStorage.getItem(`${LAST_KEY}.${userId}`) ?? "";
  } catch {
    return "";
  }
};

function pick(me: Me, wanted: string): string {
  const ids = me.workspaces.map((w) => w.id);
  if (ids.includes(wanted)) return wanted;
  const last = recall(me.user.id);
  if (ids.includes(last)) return last;
  return me.workspaces.find((w) => w.personal)?.id ?? ids[0] ?? "";
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });

  const signedIn = useCallback((me: Me, wanted = "") => {
    const workspaceId = pick(me, wanted);
    setCurrentWorkspace(workspaceId);
    remember(me.user.id, workspaceId);
    setState({ status: "signed-in", me, workspaceId });
  }, []);

  useEffect(() => {
    whenSignedOut(() => {
      setCurrentWorkspace("");
      setState({ status: "signed-out" });
    });
    api.me().then(
      (me) => signedIn(me),
      () => setState({ status: "signed-out" }),
    );
  }, [signedIn]);

  const value = useMemo<SessionApi>(() => {
    const me = state.status === "signed-in" ? state.me : (null as unknown as Me);
    const workspace =
      state.status === "signed-in" ? state.me.workspaces.find((w) => w.id === state.workspaceId)! : (null as unknown as Workspace);
    return {
      state,
      me,
      workspace,
      signedIn: (m) => signedIn(m),
      logout: async () => {
        await api.logout().catch(() => {});
        setCurrentWorkspace("");
        setState({ status: "signed-out" });
      },
      switchWorkspace: (id) => {
        if (state.status !== "signed-in") return;
        // A workspace made on another device isn't in this list yet: fetch the list again.
        if (state.me.workspaces.some((w) => w.id === id)) signedIn(state.me, id);
        else api.me().then((fresh) => signedIn(fresh, id), () => {});
      },
      reload: async (selectId) => {
        const fresh = await api.me();
        signedIn(fresh, selectId ?? (state.status === "signed-in" ? state.workspaceId : ""));
      },
    };
  }, [state, signedIn]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}

/**
 * For a page whose workflow or run isn't in the current workspace (a link from another workspace, or
 * from before a switch): finds the user's workspace that has it and switches there. Resolves to
 * false when none of their workspaces has it.
 */
export function useFindElsewhere() {
  const { state, switchWorkspace } = useSession();
  const current = state.status === "signed-in" ? state.workspaceId : "";
  return useCallback(
    async (kind: "workflow" | "run", id: string) => {
      try {
        const { workspaceId } = await api.locate(kind, id);
        if (workspaceId === current) return false;
        switchWorkspace(workspaceId);
        return true;
      } catch {
        return false;
      }
    },
    [current, switchWorkspace],
  );
}

/** Two letters for an avatar: initials of a name. */
export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] ?? ""))).toUpperCase();
}
