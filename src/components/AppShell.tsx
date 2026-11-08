import { type ReactNode, useEffect, useRef, useState } from "react";
import { LIMITS } from "../../shared/limits";
import { workspaceId, workspaceLink } from "../api";
import { Link, usePath } from "../router";
import { HOUR, runsSince, useWorkspace } from "../workspace";
import { ChevronIcon, CloseIcon, CodeIcon, CopyIcon, FlowIcon, HomeIcon, MenuIcon, PlusIcon, RunsIcon, SettingsIcon } from "./icons";
import { cn, Logo } from "./ui";

const NAV = [
  { href: "/home", label: "Home", icon: HomeIcon, match: (p: string) => p === "/home" },
  { href: "/workflows", label: "Workflows", icon: FlowIcon, match: (p: string) => p.startsWith("/workflows") },
  { href: "/runs", label: "Runs", icon: RunsIcon, match: (p: string) => p.startsWith("/runs") },
  { href: "/settings", label: "Settings", icon: SettingsIcon, match: (p: string) => p === "/settings" },
];

const TITLES: [RegExp, string][] = [
  [/^\/home$/, "Home"],
  [/^\/workflows\/new$/, "New workflow"],
  [/^\/workflows\/.+/, "Workflow"],
  [/^\/workflows$/, "Workflows"],
  [/^\/runs\/.+/, "Run"],
  [/^\/runs$/, "Runs"],
  [/^\/settings$/, "Settings"],
];

/** Two letters and a short id from the workspace id, so each browser's workspace is recognisable. */
export function workspaceMark() {
  const body = workspaceId.slice(3);
  return { letters: body.slice(0, 2).toUpperCase(), short: `${workspaceId.slice(0, 7)}…${workspaceId.slice(-4)}` };
}

function Meter({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = Math.min(100, Math.round((used / max) * 100));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-soft">{label}</span>
        <span className="font-mono text-muted tabular-nums">
          {used}/{max}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-line" role="meter" aria-label={label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={max}>
        <div className={cn("h-full rounded-full", pct >= 90 ? "bg-fail" : pct >= 70 ? "bg-retry" : "bg-spark")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Sidebar({ path, onNavigate }: { path: string; onNavigate?: () => void }) {
  const { workflows, runs } = useWorkspace();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center px-5">
        <Link href="/home" onClick={onNavigate} className="flex items-center gap-3" aria-label="Knotwork home">
          <Logo size={28} />
          <span className="font-display text-lg font-bold tracking-tight">knotwork</span>
        </Link>
      </div>
      <nav aria-label="App" className="flex flex-col gap-1 px-3 pt-2">
        {NAV.map(({ href, label, icon: I, match }) => {
          const active = match(path);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
                active ? "bg-graphite text-text" : "text-soft hover:bg-graphite/60 hover:text-text",
              )}
            >
              {active && <span className="absolute top-2 bottom-2 -left-3 w-1 rounded-r-full bg-spark" aria-hidden="true" />}
              <I className={active ? "text-spark" : "text-muted"} />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-4 rounded-xl border border-line bg-deep p-4">
          <span className="font-mono text-[11px] tracking-[0.12em] text-muted uppercase">Free plan usage</span>
          <Meter label="Workflows" used={workflows?.length ?? 0} max={LIMITS.workflowsPerWorkspace} />
          <Meter label="Runs this hour" used={runsSince(runs, HOUR).length} max={LIMITS.runsPerWorkspacePerHour} />
        </div>
        <a
          href="https://github.com/GigiBeridzeAxal/knotwork"
          className="flex h-10 items-center gap-3 rounded-lg px-3 text-sm text-soft hover:bg-graphite/60 hover:text-text"
        >
          <CodeIcon className="text-muted" />
          Source on GitHub
        </a>
      </div>
    </div>
  );
}

function AccountMenu() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const mark = workspaceMark();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-10 items-center gap-3 rounded-lg pr-2 pl-1 hover:bg-graphite"
      >
        <span className="grid size-8 place-items-center rounded-lg bg-spark font-mono text-xs font-medium text-ink">{mark.letters}</span>
        <span className="hidden flex-col items-start leading-tight md:flex">
          <span className="text-sm font-medium">Guest</span>
          <span className="font-mono text-[11px] text-muted">{mark.short}</span>
        </span>
        <ChevronIcon className={cn("hidden text-muted transition-transform md:block", open && "rotate-180")} />
      </button>
      {open && (
        <div role="menu" className="absolute top-12 right-0 z-40 w-72 rounded-xl border border-line bg-graphite p-2 shadow-2xl shadow-black/60">
          <div className="flex items-center gap-3 p-3">
            <span className="grid size-10 place-items-center rounded-lg bg-spark font-mono text-sm font-medium text-ink">{mark.letters}</span>
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">Guest workspace</span>
              <span className="truncate font-mono text-xs text-muted">{workspaceId}</span>
            </div>
          </div>
          <p className="px-3 pb-3 text-xs leading-relaxed text-muted">No account needed. This workspace lives in this browser.</p>
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            className="flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm text-soft hover:bg-ink hover:text-text"
            onClick={() =>
              navigator.clipboard.writeText(workspaceLink()).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            <CopyIcon className="text-muted" />
            {copied ? "Copied. Keep it private." : "Copy workspace link"}
          </button>
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex h-10 items-center gap-3 rounded-lg px-3 text-sm text-soft hover:bg-ink hover:text-text"
          >
            <SettingsIcon className="text-muted" />
            Workspace settings
          </Link>
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePath();
  const [drawer, setDrawer] = useState(false);
  const title = TITLES.find(([re]) => re.test(path))?.[1] ?? "Knotwork";

  useEffect(() => setDrawer(false), [path]);

  return (
    <div className="min-h-screen lg:pl-60">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line bg-ink lg:block">
        <Sidebar path={path} />
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" className="absolute inset-0 bg-black/60" aria-label="Close menu" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-line bg-ink">
            <button
              type="button"
              className="absolute top-3 right-3 grid size-10 place-items-center rounded-lg text-soft hover:bg-graphite"
              aria-label="Close menu"
              onClick={() => setDrawer(false)}
            >
              <CloseIcon />
            </button>
            <Sidebar path={path} onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-ink/90 px-4 backdrop-blur sm:px-6 lg:px-8">
        <button
          type="button"
          className="-ml-2 grid size-10 place-items-center rounded-lg text-soft hover:bg-graphite lg:hidden"
          aria-label="Open menu"
          onClick={() => setDrawer(true)}
        >
          <MenuIcon />
        </button>
        <span className="text-sm text-muted">
          <span className="hidden sm:inline">Guest workspace</span>
          <span className="hidden px-2 text-edge sm:inline">/</span>
          <span className="font-medium text-text">{title}</span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/workflows/new"
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-spark px-3 text-sm font-semibold text-ink hover:bg-spark-hover sm:px-4"
          >
            <PlusIcon />
            <span className="hidden sm:inline">New workflow</span>
          </Link>
          <Link
            href="/settings"
            aria-label="Settings"
            aria-current={path === "/settings" ? "page" : undefined}
            className={cn("grid size-10 place-items-center rounded-lg hover:bg-graphite hover:text-text", path === "/settings" ? "bg-graphite text-text" : "text-soft")}
          >
            <SettingsIcon />
          </Link>
          <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
          <AccountMenu />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">{children}</main>
    </div>
  );
}
