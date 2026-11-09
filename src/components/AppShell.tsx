import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { LIMITS } from "../../shared/limits";
import type { WorkflowSummary } from "../../shared/schema";
import { api } from "../api";
import { Link, navigate, usePath } from "../router";
import { initials, useSession } from "../session";
import { useWorkspace } from "../workspace";
import { CheckIcon, ChevronIcon, CloseIcon, CodeIcon, FlowIcon, HomeIcon, LogoutIcon, MenuIcon, PlusIcon, RunsIcon, SettingsIcon } from "./icons";
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

/** A square for a workspace and a circle for a person, so the two never look alike. */
export function Avatar({ name, size = "md", shape = "circle" }: { name: string; size?: "sm" | "md" | "lg"; shape?: "circle" | "square" }) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center bg-raised font-mono font-medium text-text ring-1 ring-edge",
        shape === "circle" ? "rounded-full" : "rounded-md",
        size === "sm" && "size-6 text-[10px]",
        size === "md" && "size-8 text-[11px]",
        size === "lg" && "size-12 text-sm",
      )}
      aria-hidden="true"
    >
      {shape === "square" ? initials(name).slice(0, 1) : initials(name)}
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

/** Closes a popover on outside click or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onEvent = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onEvent);
    document.addEventListener("keydown", onEvent);
    return () => {
      document.removeEventListener("mousedown", onEvent);
      document.removeEventListener("keydown", onEvent);
    };
  }, [open, close]);
  return ref;
}

const menuItem = "flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-[13px] text-soft transition-colors hover:bg-raised hover:text-text";
const menuPanel = "absolute z-40 rounded-2xl border border-line bg-graphite p-1.5 shadow-[0_24px_48px_-12px_rgb(0_0_0/0.7)]";

/** The current workspace's name; click it to switch workspaces or make a new one. */
function WorkspaceSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const { me, workspace, switchWorkspace, reload } = useSession();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
    setAdding(false);
    setError("");
  }, []);
  const ref = useDismiss(open, close);
  const full = me.workspaces.length >= LIMITS.workspacesPerAccount;

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const ws = await api.createWorkspace(name);
      await reload(ws.id);
      setName("");
      close();
      navigate("/home");
      onNavigate?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-0 flex-1" ref={ref}>
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-1.5 text-left transition-colors hover:bg-graphite"
      >
        <Avatar name={workspace.name} size="sm" shape="square" />
        <span className="truncate text-sm font-medium">{workspace.name}</span>
        <ChevronIcon className={cn("ml-auto size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div role="menu" aria-label="Workspaces" className={cn(menuPanel, "inset-x-0 top-11")}>
          <p className="px-2.5 pt-1.5 pb-2 font-mono text-[11px] tracking-[0.12em] text-muted uppercase">Workspaces</p>
          {me.workspaces.map((ws) => (
            <button
              key={ws.id}
              type="button"
              role="menuitemradio"
              aria-checked={ws.id === workspace.id}
              className={cn(menuItem, ws.id === workspace.id && "text-text")}
              onClick={() => {
                switchWorkspace(ws.id);
                close();
                navigate("/home");
                onNavigate?.();
              }}
            >
              <Avatar name={ws.name} size="sm" shape="square" />
              <span className="truncate">{ws.name}</span>
              {ws.id === workspace.id && <CheckIcon className="ml-auto size-4 shrink-0 text-spark" />}
            </button>
          ))}
          <div className="mx-1 my-1 h-px bg-line" />
          {adding ? (
            <form onSubmit={create} className="flex flex-col gap-2 p-1.5">
              <label htmlFor="new-ws" className="sr-only">
                Workspace name
              </label>
              <input
                id="new-ws"
                autoFocus
                maxLength={40}
                placeholder="Workspace name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-9 w-full rounded-lg border border-edge bg-ink px-2.5 text-[13px] text-text placeholder:text-muted focus:border-wire focus:outline-none"
              />
              {error && <p className="text-xs text-fail">{error}</p>}
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="h-9 rounded-full bg-text text-[13px] font-semibold text-ink transition-colors hover:bg-soft disabled:opacity-50"
              >
                {busy ? "Creating…" : "Create workspace"}
              </button>
            </form>
          ) : (
            <button type="button" role="menuitem" className={menuItem} disabled={full} onClick={() => setAdding(true)}>
              <PlusIcon className="size-4 text-muted" />
              {full ? `${LIMITS.workspacesPerAccount} workspaces is the limit` : "New workspace"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Sidebar({ path, onNavigate }: { path: string; onNavigate?: () => void }) {
  const { workflows, runsThisHour, runsLimit } = useWorkspace();
  const { workspace } = useSession();
  const full = (workflows?.length ?? 0) >= LIMITS.workflowsPerWorkspace;
  return (
    <div className="flex h-full flex-col">
      <div className="mt-2 flex h-14 shrink-0 items-center px-5">
        <Link href="/home" onClick={onNavigate} className="flex items-center gap-3" aria-label="Knotwork home">
          <Logo size={28} />
          <span className="font-display text-lg font-bold tracking-tight">knotwork</span>
        </Link>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-3 pt-3 pb-4">
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

        <section aria-label={`${workspace.name} workspace`} className="flex flex-col gap-1">
          <div className="relative flex items-center gap-1 pb-1">
            <WorkspaceSwitcher onNavigate={onNavigate} />
            {full ? (
              <span
                className="grid size-9 shrink-0 cursor-not-allowed place-items-center rounded-lg border border-line text-muted/50"
                title={`A workspace holds ${LIMITS.workflowsPerWorkspace} workflows`}
                aria-label={`New workflow (this workspace is full at ${LIMITS.workflowsPerWorkspace})`}
              >
                <PlusIcon className="size-4" />
              </span>
            ) : (
              <Link
                href="/workflows/new"
                onClick={onNavigate}
                aria-label={`New workflow in ${workspace.name}`}
                title="New workflow"
                className={cn(
                  "grid size-9 shrink-0 place-items-center rounded-lg border transition-colors",
                  path === "/workflows/new" ? "border-line-hover bg-graphite text-text" : "border-edge text-soft hover:border-line-hover hover:bg-graphite hover:text-text",
                )}
              >
                <PlusIcon className="size-4" />
              </Link>
            )}
          </div>
          {workflows && workflows.length === 0 && path !== "/workflows/new" && (
            <Link href="/workflows/new" onClick={onNavigate} className="rounded-lg px-2.5 py-2 text-[13px] text-muted hover:bg-graphite/60 hover:text-text">
              No workflows yet. Add the first one.
            </Link>
          )}
          {path === "/workflows/new" && (
            <span aria-current="page" className="flex h-8 items-center gap-3 rounded-lg bg-graphite px-2.5 text-[13px] text-text">
              <span className="grid size-[18px] place-items-center">
                <span className="size-2 rounded-full ring-1 ring-muted ring-inset" />
              </span>
              <span className="truncate italic">New workflow</span>
            </span>
          )}
          {(workflows ?? []).map((wf) => {
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
        </section>
      </div>

      <div className="flex shrink-0 flex-col gap-2 p-3">
        <div className="flex flex-col gap-4 rounded-xl border border-line p-4">
          <span className="font-mono text-[11px] tracking-[0.12em] text-muted uppercase">Free plan</span>
          <Meter label={`Workflows in ${workspace.name}`} used={workflows?.length ?? 0} max={LIMITS.workflowsPerWorkspace} />
          <Meter label="Runs this hour" used={runsThisHour} max={runsLimit} />
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
  const { me, logout } = useSession();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account menu"
        className="flex h-10 items-center gap-2.5 rounded-full p-1 transition-colors hover:bg-graphite md:pr-3"
      >
        <Avatar name={me.user.name} />
        <span className="hidden max-w-40 truncate text-[13px] font-medium md:inline">{me.user.name}</span>
        <ChevronIcon className={cn("hidden size-4 text-muted transition-transform md:block", open && "rotate-180")} />
      </button>
      {open && (
        <div role="menu" className={cn(menuPanel, "top-12 right-0 w-72")}>
          <div className="flex items-center gap-3 p-2.5">
            <Avatar name={me.user.name} />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium">{me.user.name}</span>
              <span className="truncate text-xs text-muted">{me.user.demo ? "Shared demo account" : me.user.email}</span>
            </div>
          </div>
          {me.user.demo && (
            <p className="px-2.5 pb-2.5 text-xs leading-relaxed text-muted">Anyone can use this account, and it resets every day at 03:00 UTC. Create your own to keep your workflows.</p>
          )}
          <div className="mx-1 my-1 h-px bg-line" />
          {me.user.demo && (
            <Link href="/signup" role="menuitem" onClick={close} className={cn(menuItem, "text-text")}>
              <PlusIcon className="size-[18px] text-wire" />
              Create your own account
            </Link>
          )}
          <Link href="/settings" role="menuitem" onClick={close} className={menuItem}>
            <SettingsIcon className="size-[18px] text-muted" />
            Settings
          </Link>
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            onClick={async () => {
              close();
              await logout();
              navigate("/login", { replace: true });
            }}
          >
            <LogoutIcon className="size-[18px] text-muted" />
            Log out
          </button>
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
  const { workspace } = useSession();

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
            <span className="hidden max-w-48 truncate text-muted sm:inline">{workspace.name}</span>
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
