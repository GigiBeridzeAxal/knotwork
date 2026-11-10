import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Me, Workspace } from "../shared/schema";
import { api, ApiError, setCurrentWorkspace, whenSignedOut } from "./api";
import { usePath } from "./router";

type State =
  | { status: "loading" }
  | { status: "signed-out" }
  /** The first request failed for a reason other than "not signed in", e.g. the server is over a daily limit. */
  | { status: "unavailable"; message: string }
  | { status: "signed-in"; me: Me; workspaceId: string };

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

/**
 * Whether this browser has signed in before. The session cookie can't be read from here, so this
 * is only a hint: it decides whether the public pages ask the server who is looking.
 */
const SEEN_KEY = "knotwork.signedIn";
const seen = () => {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true; // Storage blocked: ask the server, as before.
  }
};
const setSeen = (yes: boolean) => {
  try {
    if (yes) localStorage.setItem(SEEN_KEY, "1");
    else localStorage.removeItem(SEEN_KEY);
  } catch {
    // Storage blocked: the public pages keep asking.
  }
};
/** The front page and the docs read the same for everyone, so a visitor who never signed in costs no request there. */
const PUBLIC = new Set(["/", "/docs"]);
/**
 * Pages a visitor who never signed in here can only use signed out. They start signed out instead
 * of asking the server and getting a 401 back (a red line in the console on the portfolio's demo
 * link). /demo is safe too: the server keeps a signed-in account rather than swapping it for the demo.
 */
const SIGNED_OUT_PAGES = new Set(["/login", "/signup", "/recover", "/demo"]);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const path = usePath();
  /** A visitor on a public page who has never signed in here: who they are isn't asked until they leave it. */
  const idle = PUBLIC.has(path) && state.status === "loading" && !seen();

  const signedIn = useCallback((me: Me, wanted = "") => {
    const workspaceId = pick(me, wanted);
    setCurrentWorkspace(workspaceId);
    remember(me.user.id, workspaceId);
    setSeen(true);
    setState({ status: "signed-in", me, workspaceId });
  }, []);

  useEffect(
    () =>
      whenSignedOut(() => {
        setCurrentWorkspace("");
        setSeen(false);
        setState({ status: "signed-out" });
      }),
    [],
  );

  const asked = useRef(false);
  useEffect(() => {
    if (idle || asked.current) return;
    asked.current = true;
    if (SIGNED_OUT_PAGES.has(path) && !seen()) {
      setState({ status: "signed-out" });
      return;
    }
    api.me().then(
      (me) => signedIn(me),
      (e) =>
        // Only a 401 means signed out. Anything else is the server or the network, and sending
        // the user to the login page would be wrong.
        setState(
          e instanceof ApiError && e.status === 401
            ? { status: "signed-out" }
            : { status: "unavailable", message: e instanceof ApiError ? e.message : "Check your connection and try again." },
        ),
    );
    // `path` is read once, when the session first loads; later page changes don't ask again.
  }, [signedIn, idle]);

  // The actions read the latest state through a ref, so their identity never changes. Pages can
  // then list them as effect dependencies without re-running (and re-loading) on every state change.
  const stateRef = useRef(state);
  stateRef.current = state;

  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    setCurrentWorkspace("");
    setSeen(false);
    setState({ status: "signed-out" });
  }, []);

  const switchWorkspace = useCallback(
    (id: string) => {
      const now = stateRef.current;
      if (now.status !== "signed-in") return;
      // A workspace made on another device isn't in this list yet: fetch the list again.
      if (now.me.workspaces.some((w) => w.id === id)) signedIn(now.me, id);
      else api.me().then((fresh) => signedIn(fresh, id), () => {});
    },
    [signedIn],
  );

  const reload = useCallback(
    async (selectId?: string) => {
      const fresh = await api.me();
      const now = stateRef.current;
      signedIn(fresh, selectId ?? (now.status === "signed-in" ? now.workspaceId : ""));
    },
    [signedIn],
  );

  const value = useMemo<SessionApi>(() => {
    const me = state.status === "signed-in" ? state.me : (null as unknown as Me);
    const workspace =
      state.status === "signed-in" ? state.me.workspaces.find((w) => w.id === state.workspaceId)! : (null as unknown as Workspace);
    return { state, me, workspace, signedIn: (m) => signedIn(m), logout, switchWorkspace, reload };
  }, [state, signedIn, logout, switchWorkspace, reload]);

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
