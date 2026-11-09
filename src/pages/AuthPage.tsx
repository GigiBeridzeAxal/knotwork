import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { PASSWORD_MIN } from "../../shared/schema";
import { api, ApiError } from "../api";
import { cn, Field, inputClass, Logo } from "../components/ui";
import { Link, navigate } from "../router";
import { useSession } from "../session";

export const pill =
  "inline-flex h-11 w-full items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";

/** Where to go after signing in: the page that sent the user here, if it's one of ours. */
function nextPath() {
  const next = new URLSearchParams(location.search).get("next") ?? "";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") && !next.startsWith("/signup") && !next.startsWith("/recover") ? next : "/home";
}

const LOG = [
  { time: "09:00", name: "Watch a GitHub repo", note: "passed in 412ms", live: false },
  { time: "09:02", name: "Big orders only", note: "retrying, 2 of 3", live: false },
  { time: "09:04", name: "Big orders only", note: "running now", live: true },
];

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const session = useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"" | "form" | "demo">("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const signup = mode === "signup";

  useEffect(() => {
    document.title = signup ? "Create an account · Knotwork" : "Log in · Knotwork";
    setError("");
    setFieldErrors({});
  }, [signup]);

  async function finish(promise: Promise<Awaited<ReturnType<typeof api.me>>>, kind: "form" | "demo") {
    setBusy(kind);
    setError("");
    setFieldErrors({});
    try {
      session.signedIn(await promise);
      navigate(nextPath(), { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.issues?.length) {
        setFieldErrors(Object.fromEntries(e.issues.map((i) => [String(i.path[0]), i.message])));
      }
      setError((e as Error).message);
      setBusy("");
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    finish(signup ? api.signup({ name, email, password }) : api.login({ email, password }), "form");
  }

  const other = signup ? "/login" : "/signup";
  const keepNext = location.search.includes("next=") ? location.search : "";

  return (
    <AuthFrame>
      <div className="mx-auto flex w-full max-w-[400px] flex-col gap-8">
        <div className="flex flex-col gap-3">
          <h1 className="font-display text-[32px] leading-[1.1] font-bold tracking-tight text-balance sm:text-[40px]">
            {signup ? "Create your account" : "Log in"}
          </h1>
          <p className="text-soft">
            {signup ? "Free, and no email to confirm. You start with a Personal workspace." : "Welcome back. Your workflows kept running."}
          </p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {signup && (
            <Field label="Name" htmlFor="name" error={fieldErrors.name}>
              <input id="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
            </Field>
          )}
          <Field label="Email" htmlFor="email" error={fieldErrors.email}>
            <input
              id="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field
            label="Password"
            htmlFor="password"
            error={fieldErrors.password}
            hint={signup ? `At least ${PASSWORD_MIN} characters.` : undefined}
          >
            <input
              id="password"
              type="password"
              autoComplete={signup ? "new-password" : "current-password"}
              required
              minLength={signup ? PASSWORD_MIN : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </Field>
          {!signup && (
            <Link href="/recover" className="-mt-1 w-fit text-[13px] text-muted underline decoration-edge underline-offset-4 hover:text-text hover:decoration-text">
              Forgot your password?
            </Link>
          )}

          {error && !Object.keys(fieldErrors).length && (
            <p role="alert" className="text-[13px] text-fail">
              {error}
            </p>
          )}

          <button type="submit" disabled={!!busy} className={cn(pill, "mt-2 bg-text text-ink hover:bg-soft")}>
            {busy === "form" ? (signup ? "Creating your account…" : "Logging in…") : signup ? "Create account" : "Log in"}
          </button>
        </form>

        <div className="flex items-center gap-4" aria-hidden="true">
          <span className="h-px flex-1 bg-line" />
          <span className="font-mono text-[11px] tracking-[0.12em] text-muted uppercase">or</span>
          <span className="h-px flex-1 bg-line" />
        </div>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={!!busy}
            onClick={() => finish(api.demo(), "demo")}
            className={cn(pill, "border border-edge font-medium text-text hover:border-line-hover hover:bg-graphite")}
          >
            {busy === "demo" ? "Opening the demo…" : "Try the demo account"}
          </button>
          <p className="text-center text-[13px] text-muted">One shared account with example workflows. It resets every day.</p>
        </div>

        <p className="text-sm text-soft">
          {signup ? "Already have an account? " : "New to Knotwork? "}
          <Link href={`${other}${keepNext}`} className="font-medium text-text underline decoration-edge underline-offset-4 hover:decoration-text">
            {signup ? "Log in" : "Create an account"}
          </Link>
        </p>
      </div>
    </AuthFrame>
  );
}

/** The two-column frame of the signed-out pages: the form on the left, the brand panel on the right. */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen bg-ink lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <main className="flex flex-col px-4 py-6 sm:px-6 lg:px-16 lg:py-8">
        <Link href="/" className="flex w-fit items-center gap-3" aria-label="Knotwork, back to the front page">
          <Logo size={28} />
          <span className="font-display text-lg font-bold tracking-tight">knotwork</span>
        </Link>

        <div className="flex flex-1 items-center py-12">
          {children}
        </div>
      </main>

      <aside className="dots relative hidden flex-col justify-between border-l border-line bg-deep p-16 lg:flex" aria-hidden="true">
        <span className="font-mono text-[11px] tracking-[0.12em] text-muted uppercase">Knotwork</span>
        <div className="flex flex-col gap-12">
          <p className="font-display text-[64px] leading-[1.02] font-bold tracking-[-0.03em]">
            Workflows
            <br />
            <span className="text-muted">that hold.</span>
          </p>
          <ol className="flex max-w-[440px] flex-col gap-3 font-mono text-[13px]">
            {LOG.map((l) => (
              <li key={l.time} className="flex items-center gap-4 rounded-xl border border-line bg-ink/80 px-4 py-3">
                <span className={cn("size-2 shrink-0 rounded-full", l.live ? "breathe bg-spark" : l.note.startsWith("retry") ? "bg-retry" : "bg-soft")} />
                <span className="text-muted tabular-nums">{l.time}</span>
                <span className="truncate text-text">{l.name}</span>
                <span className={cn("ml-auto shrink-0", l.live ? "text-spark" : "text-muted")}>{l.note}</span>
              </li>
            ))}
          </ol>
        </div>
        <span className="text-[13px] text-muted">Retries, delays and schedules, on Cloudflare's free plan.</span>
      </aside>
    </div>
  );
}
