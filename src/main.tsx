import { lazy, StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./components/AppShell";
import "./index.css";
import { AuthPage } from "./pages/AuthPage";
import { EditorPage } from "./pages/EditorPage";
import { HomePage } from "./pages/HomePage";
import { LandingPage } from "./pages/LandingPage";
import { RunPage } from "./pages/RunPage";
import { RunsPage } from "./pages/RunsPage";
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
  if ((p = match("/workflows/new", path))) return <EditorPage key="new" id={null} />;
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

function App() {
  const path = usePath();
  const { state } = useSession();
  if (path === "/") return <LandingPage />;
  if (state.status === "loading") return blank;
  if (path === "/login" || path === "/signup") {
    return state.status === "signed-in" ? <Redirect to="/home" /> : <AuthPage key={path} mode={path === "/login" ? "login" : "signup"} />;
  }
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
