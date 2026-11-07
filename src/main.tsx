import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, getToken, onUnauthorized, setToken } from "./api";
import { Button, cn, inputClass, Logo } from "./components/ui";
import "./index.css";
import { EditorPage } from "./pages/EditorPage";
import { RunPage } from "./pages/RunPage";
import { RunsPage } from "./pages/RunsPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { Link, match, usePath } from "./router";

function Routes({ path }: { path: string }) {
  let p;
  if (path === "/" || path === "/workflows") return <WorkflowsPage />;
  if ((p = match("/workflows/new", path))) return <EditorPage key="new" id={null} />;
  if ((p = match("/workflows/:id", path))) return <EditorPage key={p.id} id={p.id} />;
  if (path === "/runs") return <RunsPage />;
  if ((p = match("/runs/:id", path))) return <RunPage key={p.id} id={p.id} />;
  return (
    <div className="py-24 text-center">
      <p className="font-display text-2xl font-bold">Nothing here</p>
      <Link href="/" className="mt-4 inline-block text-wire hover:underline">
        Back to workflows
      </Link>
    </div>
  );
}

function Shell() {
  const path = usePath();
  const nav = [
    { href: "/", label: "Workflows", active: path === "/" || path.startsWith("/workflows") },
    { href: "/runs", label: "Runs", active: path.startsWith("/runs") },
  ];
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-ink/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-3" aria-label="Knotwork home">
            <Logo />
            <span className="font-display text-xl font-bold tracking-tight">knotwork</span>
          </Link>
          <nav className="flex items-center gap-1">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={item.active ? "page" : undefined}
                className={cn(
                  "rounded-[10px] px-3 py-2 text-sm font-medium",
                  item.active ? "bg-graphite text-text" : "text-soft hover:text-text",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        <Routes path={path} />
      </main>
    </div>
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form
        className="w-full max-w-sm rounded-2xl border border-line bg-graphite p-8"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setToken(value.trim());
          try {
            await api.checkToken();
            onDone();
          } catch {
            setToken("");
            setError("That token didn't work.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="mb-6 flex items-center gap-3">
          <Logo size={40} />
          <span className="font-display text-2xl font-bold tracking-tight">knotwork</span>
        </div>
        <label htmlFor="token" className="text-[13px] text-soft">
          Access token
        </label>
        <input
          id="token"
          type="password"
          autoComplete="current-password"
          className={cn(inputClass, "mt-2")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && <p className="mt-2 text-[13px] text-fail">{error}</p>}
        <Button type="submit" variant="primary" className="mt-6 w-full" disabled={!value || busy}>
          Sign in
        </Button>
        <p className="mt-4 text-[13px] text-muted">This instance is private. The token is its ADMIN_TOKEN secret.</p>
      </form>
    </div>
  );
}

function App() {
  const [state, setState] = useState<"loading" | "signin" | "ready">("loading");
  useEffect(() => {
    api
      .config()
      .then(({ authRequired }) => setState(authRequired && !getToken() ? "signin" : "ready"))
      .catch(() => setState("ready"));
    return onUnauthorized(() => {
      setToken("");
      setState("signin");
    });
  }, []);
  if (state === "loading") return null;
  if (state === "signin") return <SignIn onDone={() => setState("ready")} />;
  return <Shell />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
