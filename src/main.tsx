import { lazy, StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./components/AppShell";
import { Button } from "./components/ui";
import "./index.css";
import { AuthPage } from "./pages/AuthPage";
import { DemoPage } from "./pages/DemoPage";
import { DocsPage } from "./pages/DocsPage";
import { EditorPage } from "./pages/EditorPage";
import { HomePage } from "./pages/HomePage";
import { LandingPage } from "./pages/LandingPage";
import { RunPage } from "./pages/RunPage";
import { RunsPage } from "./pages/RunsPage";
import { TemplatesPage } from "./pages/TemplatesPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { Link, match, navigate, usePath } from "./router";
import { SessionProvider, useSession } from "./session";
import { WorkspaceProvider } from "./workspace";

// Pages most visits never open load on demand, so the landing and login pages don't download them.
const JoinPage = lazy(() => import("./pages/JoinPage").then((m) => ({ default: m.JoinPage })));
const RecoverPage = lazy(() => import("./pages/RecoverPage").then((m) => ({ default: m.RecoverPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const blank = <div className="min-h-screen bg-ink" aria-busy="true" />;

function Routes({ path }: { path: string }) {
  let p;
  if (path === "/home") return <HomePage />;
  if (path === "/workflows") return <WorkflowsPage />;
  // Keyed by the query too: another template, or another imported file, is another new workflow.
  if ((p = match("/workflows/new", path))) return <EditorPage key={`new${location.search}`} id={null} />;
  if (path === "/templates") return <TemplatesPage />;
  if ((p = match("/workflows/:id", path))) return <EditorPage key={p.id} id={p.id} />;
  if (path === "/runs") return <RunsPage />;
  if ((p = match("/runs/:id", path))) return <RunPage key={p.id} id={p.id} />;
  if (path === "/settings") {
    return (
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-graphite" aria-busy="true" />}>
        <SettingsPage />
      </Suspense>
    );
  }
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
  if (path === "/docs") return <DocsPage />;
  if (state.status === "loading") return blank;
  if (state.status === "unavailable") return <Unavailable message={state.message} />;
  if (path === "/login" || path === "/signup") {
    // Someone trying the shared demo can still reach these pages: signing in replaces the demo session.
    const own = state.status === "signed-in" && !state.me.user.demo;
    return own ? <Redirect to="/home" /> : <AuthPage key={path} mode={path === "/login" ? "login" : "signup"} />;
  }
  if (path === "/demo") return <DemoPage />;
  if (path === "/recover") return state.status === "signed-in" ? <Redirect to="/home" /> : <Suspense fallback={blank}><RecoverPage /></Suspense>;
  if (state.status === "signed-out") return <Redirect to={`/login?next=${encodeURIComponent(path + location.search)}`} />;
  // An invite link opens on its own page, outside the app: it's about another workspace than the current one.
  const join = match("/join/:token", path);
  if (join) return <Suspense fallback={blank}><JoinPage key={join.token} token={join.token} /></Suspense>;
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
