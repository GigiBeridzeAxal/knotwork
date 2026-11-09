import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./components/AppShell";
import { Button } from "./components/ui";
import "./index.css";
import { AuthPage } from "./pages/AuthPage";
import { EditorPage } from "./pages/EditorPage";
import { HomePage } from "./pages/HomePage";
import { LandingPage } from "./pages/LandingPage";
import { RunPage } from "./pages/RunPage";
import { RunsPage } from "./pages/RunsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { Link, match, navigate, usePath } from "./router";
import { SessionProvider, useSession } from "./session";
import { WorkspaceProvider } from "./workspace";

function Routes({ path }: { path: string }) {
  let p;
  if (path === "/home") return <HomePage />;
  if (path === "/workflows") return <WorkflowsPage />;
  if ((p = match("/workflows/new", path))) return <EditorPage key="new" id={null} />;
  if ((p = match("/workflows/:id", path))) return <EditorPage key={p.id} id={p.id} />;
  if (path === "/runs") return <RunsPage />;
  if ((p = match("/runs/:id", path))) return <RunPage key={p.id} id={p.id} />;
  if (path === "/settings") return <SettingsPage />;
  return (
    <div className="py-24 text-center">
      <p className="font-display text-2xl font-bold">Nothing here</p>
      <Link href="/home" className="mt-4 inline-block text-wire hover:underline">
        Back to home
      </Link>
    </div>
  );
}

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

/** The server couldn't say whether this browser is signed in (an outage, not a sign-out). */
function Unavailable({ message }: { message: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-ink px-4 text-center">
      <p className="font-display text-2xl font-bold text-balance">Knotwork isn&apos;t answering right now</p>
      <p className="max-w-md text-sm text-soft">{message} Your workflows and runs are safe.</p>
      <Button onClick={() => location.reload()}>Try again</Button>
    </main>
  );
}

function App() {
  const path = usePath();
  const { state } = useSession();
  if (path === "/") return <LandingPage />;
  if (state.status === "loading") return <div className="min-h-screen bg-ink" aria-busy="true" />;
  if (state.status === "unavailable") return <Unavailable message={state.message} />;
  if (path === "/login" || path === "/signup") {
    // Someone trying the shared demo can still reach these pages: signing in replaces the demo session.
    const own = state.status === "signed-in" && !state.me.user.demo;
    return own ? <Redirect to="/home" /> : <AuthPage key={path} mode={path === "/login" ? "login" : "signup"} />;
  }
  if (state.status === "signed-out") return <Redirect to={`/login?next=${encodeURIComponent(path + location.search)}`} />;
  return (
    <WorkspaceProvider key={state.workspaceId} path={path}>
      <AppShell>
        <Routes key={state.workspaceId} path={path} />
      </AppShell>
    </WorkspaceProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
