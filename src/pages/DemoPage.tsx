import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Link, navigate } from "../router";
import { useSession } from "../session";

/** Where to go after signing in: `?next=` when it is a path inside the app, else home. */
function nextPath() {
  const next = new URLSearchParams(location.search).get("next") ?? "";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/demo") && !next.startsWith("/login") && !next.startsWith("/signup")
    ? next
    : "/home";
}

/**
 * /demo signs a visitor into the shared demo account and opens its home page (or `?next=`, e.g.
 * /demo?next=/workflows/wf_demo_2), so a link from the portfolio or the docs reaches a working
 * dashboard in one click. Someone already signed in just goes
 * home: their own account is never swapped for the demo.
 */
export function DemoPage() {
  const session = useSession();
  const [error, setError] = useState("");
  const started = useRef(false);
  const status = session.state.status;

  useEffect(() => {
    if (status === "loading" || started.current) return;
    started.current = true; // StrictMode runs effects twice in development; sign in once.
    if (status === "signed-in") {
      navigate(nextPath(), { replace: true });
      return;
    }
    api.demo().then(
      (me) => {
        session.signedIn(me);
        navigate(nextPath(), { replace: true });
      },
      (e: Error) => setError(e.message),
    );
  }, [status, session]);

  return (
    <main className="grid min-h-screen place-items-center bg-ink px-4 text-center" aria-busy={!error}>
      {error ? (
        <div className="flex max-w-[400px] flex-col items-center gap-4">
          <p className="font-display text-2xl font-bold">The demo didn't open</p>
          <p role="alert" className="text-soft">{error}</p>
          <Link href="/login" className="text-wire hover:underline">
            Log in instead
          </Link>
        </div>
      ) : (
        <p role="status" className="text-soft">Opening the demo…</p>
      )}
    </main>
  );
}
