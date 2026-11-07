import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { workspaceId } from "./api";
import { cn, Logo } from "./components/ui";
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
      <WorkspaceFooter />
    </div>
  );
}

function WorkspaceFooter() {
  const [copied, setCopied] = useState(false);
  return (
    <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-6 text-sm text-muted sm:px-6">
      <p>Your workflows are private to this browser. No sign-up needed.</p>
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          className="min-h-11 text-soft hover:text-text"
          onClick={() =>
            navigator.clipboard.writeText(`${location.origin}/?workspace=${workspaceId}`).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? "Link copied. Keep it private." : "Copy a link to open this workspace elsewhere"}
        </button>
        <a href="https://github.com/GigiBeridzeAxal/knotwork" className="min-h-11 content-center text-soft hover:text-text">
          Source on GitHub
        </a>
      </div>
    </footer>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
