import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./api";
import { AppShell } from "./components/AppShell";
import "./index.css";
import { EditorPage } from "./pages/EditorPage";
import { HomePage } from "./pages/HomePage";
import { LandingPage } from "./pages/LandingPage";
import { RunPage } from "./pages/RunPage";
import { RunsPage } from "./pages/RunsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { Link, match, usePath } from "./router";
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

function App() {
  const path = usePath();
  if (path === "/") return <LandingPage />;
  return (
    <WorkspaceProvider path={path}>
      <AppShell>
        <Routes path={path} />
      </AppShell>
    </WorkspaceProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
