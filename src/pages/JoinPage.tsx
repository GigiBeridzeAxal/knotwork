import { useEffect, useState } from "react";
import type { InvitePreview } from "../../shared/schema";
import { api, ApiError } from "../api";
import { Avatar } from "../components/AppShell";
import { cn } from "../components/ui";
import { Link, navigate } from "../router";
import { useSession } from "../session";
import { AuthFrame, pill } from "./AuthPage";
import { ROLE_CAN, ROLE_LABEL } from "./settings/parts";

const primary = cn(pill, "bg-text text-ink hover:bg-soft");
const secondary = cn(pill, "border border-edge font-medium text-text hover:border-line-hover hover:bg-graphite");
const textLink = "font-medium text-text underline decoration-edge underline-offset-4 hover:decoration-text";

type State = { kind: "loading" } | { kind: "ready"; invite: InvitePreview } | { kind: "broken"; status: number; message: string };

/** Opened from an invite link. Shows whose workspace it is and the role, then joins on a click. */
export function JoinPage({ token }: { token: string }) {
  const { me, reload, logout } = useSession();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const demo = me.user.demo;

  useEffect(() => {
    document.title = "Join a workspace · Knotwork";
    let stale = false;
    api.invite(token).then(
      (invite) => !stale && setState({ kind: "ready", invite }),
      (e) => !stale && setState({ kind: "broken", status: e instanceof ApiError ? e.status : 0, message: (e as Error).message }),
    );
    return () => {
      stale = true;
    };
  }, [token]);

  async function join() {
    setBusy(true);
    setError("");
    try {
      const { workspaceId } = await api.acceptInvite(token);
      await reload(workspaceId);
      navigate("/home", { replace: true });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function open(id: string) {
    setBusy(true);
    await reload(id).catch(() => {});
    navigate("/home", { replace: true });
  }

  /** Logs out of this account and comes back to the invite after signing up or in as someone else. */
  async function switchAccount(to: "/signup" | "/login") {
    await logout();
    navigate(`${to}?next=${encodeURIComponent(`/join/${token}`)}`, { replace: true });
  }
  const signUpInstead = () => switchAccount("/signup");

  return (
    <AuthFrame>
      <div className="mx-auto flex w-full max-w-[400px] flex-col gap-8" aria-busy={state.kind === "loading"}>
        {state.kind === "loading" && (
          <div className="flex flex-col gap-4" aria-label="Loading the invite">
            <div className="h-12 w-4/5 animate-pulse rounded-xl bg-graphite" />
            <div className="h-24 animate-pulse rounded-2xl bg-graphite" />
            <div className="h-11 animate-pulse rounded-full bg-graphite" />
          </div>
        )}

        {state.kind === "broken" && demo && <DemoNote onSignUp={signUpInstead} />}

        {state.kind === "broken" && !demo && (
          <>
            <div className="flex flex-col gap-3">
              <h1 className="font-display text-[32px] leading-[1.1] font-bold tracking-tight text-balance sm:text-[40px]">
                {state.status === 410 ? "This invite link has run out" : state.status === 404 ? "This invite link doesn't work" : "Couldn't open this invite"}
              </h1>
              <p className="text-soft">{state.message}</p>
              <p className="text-[13px] text-muted">Ask the person who sent it for a new link. Links last a few days and let a set number of people in.</p>
            </div>
            <Link href="/home" className={secondary}>
              Go to your workspaces
            </Link>
          </>
        )}

        {state.kind === "ready" && (
          <>
            <div className="flex flex-col gap-3">
              <p className="font-mono text-[11px] tracking-[0.12em] text-muted uppercase">Invite</p>
              <h1 className="font-display text-[32px] leading-[1.1] font-bold tracking-tight text-balance sm:text-[40px]">
                {state.invite.already ? (
                  <>You're already in {state.invite.workspaceName}</>
                ) : (
                  <>
                    {state.invite.ownerName} invited you to <span className="text-spark">{state.invite.workspaceName}</span>
                  </>
                )}
              </h1>
              {!state.invite.already && (
                <p className="text-soft">
                  You'd join as {state.invite.role === "editor" ? "an editor" : "a viewer"}.
                </p>
              )}
            </div>

            <div className="flex items-center gap-4 rounded-2xl border border-line bg-graphite p-5">
              <Avatar name={state.invite.workspaceName} size="lg" shape="square" />
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{state.invite.workspaceName}</span>
                  <span className="shrink-0 rounded-full bg-raised px-2 py-0.5 font-mono text-[11px] text-soft">{ROLE_LABEL[state.invite.role]}</span>
                </span>
                <span className="text-[13px] text-muted">
                  {state.invite.ownerName}'s workspace. {ROLE_CAN[state.invite.role]}
                </span>
              </div>
            </div>

            {demo ? (
              <DemoNote onSignUp={signUpInstead} short />
            ) : state.invite.already ? (
              <button type="button" className={primary} disabled={busy} onClick={() => open(state.invite.workspaceId)}>
                Open workspace
              </button>
            ) : (
              <div className="flex flex-col gap-3">
                <button type="button" className={primary} disabled={busy} onClick={join}>
                  {busy ? "Joining…" : "Join workspace"}
                </button>
                {error && (
                  <p role="alert" className="text-[13px] text-fail">
                    {error}
                  </p>
                )}
                <p className="text-[13px] text-muted">
                  It shows up in your workspace menu next to your own. You can leave any time from Settings.
                </p>
              </div>
            )}

            {!demo && (
              <p className="text-sm text-soft">
                Logged in as {me.user.name}.{" "}
                <button type="button" className={textLink} onClick={() => switchAccount("/login")}>
                  Use another account
                </button>
              </p>
            )}
          </>
        )}
      </div>
    </AuthFrame>
  );
}

function DemoNote({ onSignUp, short = false }: { onSignUp: () => void; short?: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      {!short && (
        <h1 className="font-display text-[32px] leading-[1.1] font-bold tracking-tight text-balance sm:text-[40px]">Make an account to join</h1>
      )}
      <p className="text-soft">
        You're using the shared demo account. Anyone can use it, so it can't join other people's workspaces. Create your own account, free and with no
        email to confirm, and this invite opens again afterwards.
      </p>
      <button type="button" className={primary} onClick={onSignUp}>
        Create an account
      </button>
    </div>
  );
}
