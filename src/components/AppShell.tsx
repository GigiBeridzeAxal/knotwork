import { type ReactNode, useEffect, useRef, useState } from "react";
import { LIMITS } from "../../shared/limits";
import type { WorkflowSummary } from "../../shared/schema";
import { workspaceId, workspaceLink } from "../api";
import { Link, usePath } from "../router";
import { HOUR, runsSince, useWorkspace } from "../workspace";
import { ChevronIcon, CloseIcon, CodeIcon, CopyIcon, FlowIcon, HomeIcon, MenuIcon, PlusIcon, RunsIcon, SettingsIcon } from "./icons";
import { cn, Logo } from "./ui";

const NAV = [
  { href: "/home", label: "Home", icon: HomeIcon, match: (p: string) => p === "/home" },
  { href: "/workflows", label: "Workflows", icon: FlowIcon, match: (p: string) => p === "/workflows" },
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

export function Avatar({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-raised font-mono font-medium text-text ring-1 ring-edge",
        size === "md" ? "size-8 text-[11px]" : "size-12 text-sm",
      )}
      aria-hidden="true"
    >
      {workspaceMark().letters}
    </span>
  );
}

/** How a workflow is doing, as one dot: lime while it is on and its last run held, red after a failure, a ring when off. */
export function WorkflowDot({ wf }: { wf: Pick<WorkflowSummary, "enabled" | "lastRun"> }) {
  const s = wf.lastRun?.status;
  if (!wf.enabled) return <span className="size-2 shrink-0 rounded-full ring-1 ring-muted ring-inset" aria-label="Off" />;
  if (s === "failed") return <span className="size-2 shrink-0 rounded-full bg-fail" aria-label="Last run failed" />;
  if (s === "running" || s === "queued" || s === "waiting")
    return <span className="breathe size-2 shrink-0 rounded-full bg-spark" aria-label="Running" />;
  return <span className="size-2 shrink-0 rounded-full bg-spark" aria-label="On" />;
}

function Meter({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = Math.min(100, Math.round((used / max) * 100));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-soft">{label}</span>
        <span className="font-mono text-[11px] text-muted tabular-nums">
          {used}/{max}
        </span>
      </div>
      <div className="h-0.5 overflow-hidden rounded-full bg-raised" role="meter" aria-label={label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={max}>
        <div className={cn("h-full rounded-full", pct >= 90 ? "bg-fail" : pct >= 70 ? "bg-retry" : "bg-soft")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const sectionLabel = "px-2.5 font-mono text-[11px] tracking-[0.12em] text-muted uppercase";

function Sidebar({ path, onNavigate }: { path: string; onNavigate?: () => void }) {
  const { workflows, runs } = useWorkspace();
  const shown = (workflows ?? []).slice(0, 6);
  return (
    <div className="flex h-full flex-col">
      <div className="mt-2 flex h-14 shrink-0 items-center px-5">
        <Link href="/home" onClick={onNavigate} className="flex items-center gap-3" aria-label="Knotwork home">
          <Logo size={28} />
          <span className="font-display text-lg font-bold tracking-tight">knotwork</span>
        </Link>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-3 pt-3 pb-4">
        <Link
          href="/workflows/new"
          onClick={onNavigate}
          className="flex h-9 shrink-0 items-center gap-2 rounded-full border border-edge px-3.5 text-[13px] font-medium text-text transition-colors hover:border-line-hover hover:bg-graphite"
        >
          <PlusIcon className="size-4 text-spark" />
          New workflow
        </Link>

        <nav aria-label="App" className="flex flex-col gap-0.5">
          {NAV.map(({ href, label, icon: I, match }) => {
            const active = match(path);
            return (
              <Link
                key={href}
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm font-medium transition-colors",
                  active ? "bg-graphite text-text" : "text-soft hover:bg-graphite/60 hover:text-text",
                )}
              >
                <I className={cn("size-[18px]", active ? "text-spark" : "text-muted")} />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between pr-2.5">
            <span className={sectionLabel}>Workflows</span>
            {workflows && workflows.length > shown.length && (
              <Link href="/workflows" onClick={onNavigate} className="text-xs text-muted hover:text-text">
                All {workflows.length}
              </Link>
            )}
          </div>
          {workflows && workflows.length === 0 && <p className="px-2.5 py-1.5 text-[13px] text-muted">None yet</p>}
          {shown.map((wf) => {
            const active = path === `/workflows/${wf.id}`;
            return (
              <Link
                key={wf.id}
                href={`/workflows/${wf.id}`}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-8 items-center gap-3 rounded-lg px-2.5 text-[13px] transition-colors",
                  active ? "bg-graphite text-text" : "text-soft hover:bg-graphite/60 hover:text-text",
                )}
              >
                <span className="grid size-[18px] place-items-center">
                  <WorkflowDot wf={wf} />
                </span>
                <span className="truncate">{wf.name}</span>
              </Link>
            );
          })}
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2 p-3">
        <div className="flex flex-col gap-4 rounded-xl border border-line p-4">
          <span className="font-mono text-[11px] tracking-[0.12em] text-muted uppercase">Free plan</span>
          <Meter label="Workflows" used={workflows?.length ?? 0} max={LIMITS.workflowsPerWorkspace} />
          <Meter label="Runs this hour" used={runsSince(runs, HOUR).length} max={LIMITS.runsPerWorkspacePerHour} />
        </div>
        <a
          href="https://github.com/GigiBeridzeAxal/knotwork"
          className="flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13px] text-muted transition-colors hover:bg-graphite/60 hover:text-text"
        >
          <CodeIcon className="size-[18px]" />
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

  const item = "flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-[13px] text-soft transition-colors hover:bg-raised hover:text-text";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Workspace menu"
        className="flex h-10 items-center gap-2.5 rounded-full p-1 transition-colors hover:bg-graphite md:pr-3"
      >
        <Avatar />
        <span className="hidden text-[13px] font-medium md:inline">Guest</span>
        <ChevronIcon className={cn("hidden size-4 text-muted transition-transform md:block", open && "rotate-180")} />
      </button>
      {open && (
        <div role="menu" className="absolute top-12 right-0 z-40 w-72 rounded-2xl border border-line bg-graphite p-1.5 shadow-[0_24px_48px_-12px_rgb(0_0_0/0.7)]">
          <div className="flex items-center gap-3 p-2.5">
            <Avatar />
            <div className="flex min-w-0 flex-col">
              <span className="text-[13px] font-medium">Guest workspace</span>
              <span className="truncate font-mono text-[11px] text-muted">{mark.short}</span>
            </div>
          </div>
          <p className="px-2.5 pb-2.5 text-xs leading-relaxed text-muted">No account needed. Your workspace lives in this browser.</p>
          <div className="mx-1 my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() =>
              navigator.clipboard.writeText(workspaceLink()).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            <CopyIcon className="size-[18px] text-muted" />
            {copied ? "Copied. Keep it private." : "Copy workspace link"}
          </button>
          <Link href="/settings" role="menuitem" onClick={() => setOpen(false)} className={item}>
            <SettingsIcon className="size-[18px] text-muted" />
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
  const sheet = useRef<HTMLDivElement>(null);
  const title = TITLES.find(([re]) => re.test(path))?.[1] ?? "Knotwork";

  // On wide screens the sheet scrolls, not the window, so start each page at its top.
  useEffect(() => {
    setDrawer(false);
    sheet.current?.scrollTo(0, 0);
  }, [path]);

  return (
    <div className="min-h-screen bg-ink">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 lg:block">
        <Sidebar path={path} />
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" className="absolute inset-0 bg-black/70" aria-label="Close menu" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-line bg-ink">
            <button
              type="button"
              className="absolute top-4 right-3 grid size-10 place-items-center rounded-full text-soft hover:bg-graphite"
              aria-label="Close menu"
              onClick={() => setDrawer(false)}
            >
              <CloseIcon />
            </button>
            <Sidebar path={path} onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      <div
        ref={sheet}
        className="sheet-scroll lg:fixed lg:inset-y-2 lg:right-2 lg:left-60 lg:overflow-y-auto lg:rounded-2xl lg:border lg:border-line lg:bg-deep"
      >
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-ink/85 px-4 backdrop-blur-md sm:px-6 lg:bg-deep/85 lg:px-10">
          <button
            type="button"
            className="-ml-2 grid size-10 place-items-center rounded-full text-soft hover:bg-graphite lg:hidden"
            aria-label="Open menu"
            onClick={() => setDrawer(true)}
          >
            <MenuIcon />
          </button>
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px]">
            <span className="hidden text-muted sm:inline">Guest workspace</span>
            <span className="hidden text-edge sm:inline" aria-hidden="true">
              /
            </span>
            <span className="truncate font-medium text-text">{title}</span>
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <Link
              href="/settings"
              aria-label="Settings"
              aria-current={path === "/settings" ? "page" : undefined}
              className={cn(
                "grid size-10 place-items-center rounded-full transition-colors hover:bg-graphite hover:text-text",
                path === "/settings" ? "text-text" : "text-muted",
              )}
            >
              <SettingsIcon className="size-[18px]" />
            </Link>
            <span className="mx-2 h-5 w-px bg-line" aria-hidden="true" />
            <AccountMenu />
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1200px] px-4 py-8 sm:px-6 sm:py-10 lg:px-10">{children}</main>
      </div>
    </div>
  );
}
