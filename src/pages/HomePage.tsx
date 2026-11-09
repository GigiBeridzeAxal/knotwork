import { type ReactNode, useEffect, useRef, useState } from "react";
import { canEdit, type Run, type RunStatus, type StepType, type Trigger, type WorkflowSummary } from "../../shared/schema";
import { api } from "../api";
import { WorkflowDot } from "../components/AppShell";
import { ArrowIcon, CloseIcon, PlusIcon } from "../components/icons";
import { cn, duration, timeAgo } from "../components/ui";
import { EXAMPLES } from "../../shared/examples";
import { Link, navigate } from "../router";
import { useSession } from "../session";
import { HOUR, runsSince, useWorkspace } from "../workspace";

const DAY = 24 * HOUR;

/* Color has one job on this page: success stays quiet, problems are red or amber, and lime only means live. */
type Kind = "pass" | "stop" | "wait" | "fail" | "live";
const KIND_ORDER: Kind[] = ["pass", "stop", "wait", "fail", "live"];

function kindOf(s: RunStatus): Kind {
  if (s === "succeeded") return "pass";
  if (s === "stopped") return "stop";
  if (s === "failed") return "fail";
  if (s === "waiting") return "wait";
  return "live";
}

const FILL: Record<Kind, string> = {
  pass: "bg-muted",
  stop: "bg-line-hover",
  wait: "bg-retry",
  fail: "bg-fail",
  live: "bg-spark breathe",
};

const WORD: Record<Kind, { text: string; color: string }> = {
  pass: { text: "ok", color: "text-muted" },
  stop: { text: "filtered", color: "text-muted" },
  wait: { text: "waiting", color: "text-retry" },
  fail: { text: "failed", color: "text-fail" },
  live: { text: "running", color: "text-spark" },
};

const TRIGGER: Record<Trigger["type"], string> = { webhook: "Webhook", schedule: "Schedule", manual: "Manual" };
const STEP: Record<StepType, string> = { http: "HTTP", transform: "Transform", filter: "Filter", delay: "Delay", log: "Log", if: "If", loop: "Loop", slack: "Slack", discord: "Discord", telegram: "Telegram", github: "GitHub" };

const eyebrow = "font-mono text-[11px] tracking-[0.12em] text-muted uppercase";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const hourLabel = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric" }).replace(" ", "").toLowerCase();

/* ---------- Status headline ---------- */

function Headline({ workflows }: { workflows: WorkflowSummary[] }) {
  const on = workflows.filter((w) => w.enabled);
  const failing = on.filter((w) => w.lastRun?.status === "failed");
  const holding = on.length - failing.length;
  const word = (n: number) => (n === 1 ? "workflow" : "workflows");

  let first: string;
  let second: string;
  if (on.length === 0) {
    first = "Every workflow";
    second = "is switched off";
  } else if (failing.length === 0) {
    first = on.length === 1 ? "Your workflow" : `All ${on.length} workflows`;
    second = on.length === 1 ? "is holding" : "are holding";
  } else {
    first = `${holding} of ${on.length} ${word(on.length)}`;
    second = holding === 1 ? "is holding" : "are holding";
  }

  return (
    <div className="flex flex-col gap-5">
      <p className={eyebrow}>{new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p>
      <h1 className="font-display text-[40px] leading-[44px] font-bold tracking-[-0.04em] sm:text-[56px] sm:leading-[56px]">
        <span className="block text-text">{first}</span>
        <span className="block text-muted">
          {second}
          <span className={failing.length ? "text-fail" : "text-spark"}>.</span>
        </span>
      </h1>
      {failing.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[15px] text-soft">
          <span className="size-2 rounded-full bg-fail" aria-hidden="true" />
          {failing.length === 1 ? (
            <>
              <span>
                <span className="text-text">{failing[0].name}</span> failed {timeAgo(failing[0].lastRun!.createdAt)}.
              </span>
              <Link href={`/runs/${failing[0].lastRun!.id}`} className="inline-flex items-center gap-1 text-text underline decoration-edge underline-offset-4 hover:decoration-text">
                Open the run
                <ArrowIcon className="size-4" />
              </Link>
            </>
          ) : (
            <>
              <span>
                <span className="text-text">{failing[0].name}</span> and {failing.length - 1} more failed on their last run.
              </span>
              <Link href="/runs" className="inline-flex items-center gap-1 text-text underline decoration-edge underline-offset-4 hover:decoration-text">
                See runs
                <ArrowIcon className="size-4" />
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/* ---------- Stat strip ---------- */

function Value({ children }: { children: string }) {
  const m = /^([\d.,/]+)(\D*)$/.exec(children);
  return (
    <span className="font-display text-[40px] leading-10 font-bold tracking-[-0.03em] tabular-nums">
      {m ? m[1] : children}
      {m?.[2] && <span className="ml-0.5 text-2xl text-muted">{m[2]}</span>}
    </span>
  );
}

function Stat({ label, value, sub, alert }: { label: string; value: string; sub: string; alert?: boolean }) {
  return (
    <div className="flex flex-col gap-3 bg-ink py-6 pr-4 pl-5 odd:pl-0 lg:bg-deep lg:odd:pl-5 lg:first:pl-0">
      <dt className={cn(eyebrow, "flex items-center gap-2")}>
        {alert && <span className="size-1.5 rounded-full bg-fail" aria-hidden="true" />}
        {label}
      </dt>
      <dd>
        <Value>{value}</Value>
      </dd>
      <dd className="text-[13px] text-muted">{sub}</dd>
    </div>
  );
}

function Stats({ runs }: { runs: Run[] }) {
  const passed = runs.filter((r) => r.status === "succeeded").length;
  const failed = runs.filter((r) => r.status === "failed");
  const live = runs.filter((r) => kindOf(r.status) === "live").length;
  const done = passed + failed.length;
  const finished = runs.filter((r) => r.finishedAt);
  const avg = finished.length ? Math.round(finished.reduce((s, r) => s + (r.finishedAt! - r.createdAt), 0) / finished.length) : 0;
  return (
    <dl className="grid grid-cols-2 gap-px border-y border-line bg-line lg:grid-cols-4">
      <Stat label="Runs · 24h" value={String(runs.length)} sub={live ? `${live} running right now` : "None running right now"} />
      <Stat label="Passed" value={done ? `${Math.round((passed / done) * 100)}%` : "—"} sub={done ? `${passed} of ${done} finished` : "Nothing finished yet"} />
      <Stat
        label="Failed"
        value={String(failed.length)}
        sub={failed.length ? `Last one ${timeAgo(failed[0].createdAt)}` : "None in 24 hours"}
        alert={failed.length > 0}
      />
      <Stat label="Average run" value={finished.length ? duration(avg) : "—"} sub="Trigger to last step" />
    </dl>
  );
}

/* ---------- Run board: one lit dot per run, one column per hour ---------- */

function RunBoard({ runs, empty }: { runs: Run[]; empty?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const small = width > 0 && width < 640;
  const dot = small ? 6 : 10;
  const gap = small ? 3 : 4;

  const end = Math.floor(Date.now() / HOUR) * HOUR + HOUR;
  const buckets = Array.from({ length: 24 }, (_, i) => ({ start: end - (24 - i) * HOUR, n: { pass: 0, stop: 0, wait: 0, fail: 0, live: 0 } as Record<Kind, number> }));
  for (const r of runs) {
    const i = Math.floor((r.createdAt - (end - DAY)) / HOUR);
    if (i >= 0 && i < 24) buckets[i].n[kindOf(r.status)]++;
  }
  const most = Math.max(0, ...buckets.map((b) => KIND_ORDER.reduce((s, k) => s + b.n[k], 0)));
  // One dot column per hour on phones, two on wider screens (three for a very busy day), and just
  // enough rows that the busiest hour fills about four fifths of the board.
  const per = small ? 1 : most > 32 ? 3 : 2;
  const rows = Math.min(12, Math.max(8, Math.ceil(Math.ceil(most / per) / 0.8)));
  const capacity = per * rows;
  const scale = Math.max(1, Math.ceil(most / capacity));

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-graphite" aria-labelledby="board-title">
      <div className="flex h-11 items-center gap-4 border-b border-line px-4">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-raised" />
          <span className="size-2.5 rounded-full bg-raised" />
          <span className="size-2.5 rounded-full bg-raised" />
        </span>
        <h2 id="board-title" className="flex-1 text-center font-mono text-xs text-muted">
          runs · last 24 hours
        </h2>
        <span className="flex items-center gap-2 font-mono text-[11px] tracking-[0.12em] text-spark uppercase">
          <span className="breathe size-1.5 rounded-full bg-spark" aria-hidden="true" />
          Live
        </span>
      </div>

      <div className="flex flex-col gap-4 p-4 sm:p-6">
        <div ref={ref} className="flex justify-between" role="img" aria-label={`${runs.length} runs in the last 24 hours`}>
          {width > 0 &&
            buckets.map((b, i) => {
              const cells: Kind[] = [];
              for (const k of KIND_ORDER) for (let j = 0; j < Math.ceil(b.n[k] / scale); j++) cells.push(k);
              while (cells.length > capacity) cells.splice(cells.indexOf("pass") >= 0 ? cells.indexOf("pass") : 0, 1);
              const now = i === 23;
              const total = KIND_ORDER.reduce((s, k) => s + b.n[k], 0);
              return (
                <div
                  key={b.start}
                  title={`${hourLabel(b.start)}: ${total} ${total === 1 ? "run" : "runs"}${b.n.fail ? `, ${b.n.fail} failed` : ""}`}
                  className="grid"
                  style={{ gridTemplateColumns: `repeat(${per}, ${dot}px)`, gridAutoRows: `${dot}px`, gap }}
                >
                  {Array.from({ length: capacity }, (_, v) => {
                    const r = Math.floor(v / per);
                    const c = v % per;
                    const k = cells[(rows - 1 - r) * per + c];
                    return (
                      <span
                        key={v}
                        className={cn("rounded-full", !k ? "bg-raised" : k === "pass" && now ? "bg-spark" : FILL[k])}
                      />
                    );
                  })}
                </div>
              );
            })}
          {width === 0 && <div style={{ height: rows * (dot + gap) }} />}
        </div>

        <div className="flex justify-between font-mono text-[11px] text-muted" aria-hidden="true">
          {buckets.map((b, i) => (
            <span key={b.start} className="relative" style={{ width: per * dot + (per - 1) * gap }}>
              {i % 6 === 0 && <span className="absolute left-0 whitespace-nowrap">{hourLabel(b.start)}</span>}
              {i === 23 && <span className="absolute right-0 whitespace-nowrap text-spark">now</span>}
              &nbsp;
            </span>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line pt-4 text-xs text-soft">
          {empty ? (
            <span className="text-muted">Each run lights up a dot here as it happens.</span>
          ) : (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <Legend fill="bg-muted">Passed</Legend>
              <Legend fill="bg-line-hover">Filtered</Legend>
              <Legend fill="bg-retry">Waiting to retry</Legend>
              <Legend fill="bg-fail">Failed</Legend>
              <Legend fill="bg-spark">This hour</Legend>
            </div>
          )}
          <span className="font-mono text-[11px] text-muted">{scale === 1 ? "1 dot = 1 run" : `1 dot ≈ ${scale} runs`}</span>
        </div>
      </div>
    </section>
  );
}

function Legend({ fill, children }: { fill: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className={cn("size-2 rounded-full", fill)} aria-hidden="true" />
      {children}
    </span>
  );
}

/* ---------- Workflows, drawn as their wires ---------- */

function Pipeline({ wf }: { wf: Pick<WorkflowSummary, "trigger" | "steps"> }) {
  const steps = wf.steps.slice(0, 3);
  const more = wf.steps.length - steps.length;
  const chip = "flex h-6 shrink-0 items-center rounded-md border px-2 font-mono text-[10.5px] tracking-[0.08em] uppercase";
  return (
    <div className="flex min-w-0 items-center overflow-hidden" aria-hidden="true">
      <span className={cn(chip, "border-edge bg-deep text-text")}>{TRIGGER[wf.trigger.type]}</span>
      {steps.map((s) => (
        <span key={s.id} className="flex shrink-0 items-center">
          <span className="h-px w-3 bg-edge" />
          <span className={cn(chip, "border-line bg-deep text-muted")}>{STEP[s.type]}</span>
        </span>
      ))}
      {more > 0 && (
        <span className="flex shrink-0 items-center">
          <span className="h-px w-3 bg-edge" />
          <span className={cn(chip, "border-dashed border-line text-muted")}>+{more}</span>
        </span>
      )}
    </div>
  );
}

function History({ runs }: { runs: Run[] }) {
  const last = runs.slice(0, 12).reverse();
  return (
    <div className="flex items-end gap-[3px]" aria-label={`Last ${last.length} runs`}>
      {Array.from({ length: 12 - last.length }, (_, i) => (
        <span key={`e${i}`} className="h-5 w-1 rounded-full bg-raised" />
      ))}
      {last.map((r) => (
        <span key={r.id} className={cn("h-5 w-1 rounded-full", FILL[kindOf(r.status)])} title={`${WORD[kindOf(r.status)].text} · ${timeAgo(r.createdAt)}`} />
      ))}
    </div>
  );
}

function PanelHead({ title, meta, href, label }: { title: string; meta?: string; href: string; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4 sm:px-6">
      <div className="flex items-baseline gap-3">
        <h2 className="font-display text-lg font-bold tracking-tight">{title}</h2>
        {meta && <span className="font-mono text-[11px] text-muted">{meta}</span>}
      </div>
      <Link href={href} className="flex items-center gap-1 text-[13px] text-soft transition-colors hover:text-text">
        {label}
        <ArrowIcon className="size-4" />
      </Link>
    </div>
  );
}

function Workflows({ workflows, runs }: { workflows: WorkflowSummary[]; runs: Run[] }) {
  const on = workflows.filter((w) => w.enabled).length;
  return (
    <section className="@container rounded-2xl border border-line bg-graphite">
      <PanelHead title="Workflows" meta={`${on} on · ${workflows.length - on} off`} href="/workflows" label="All workflows" />
      <ul>
        {workflows.slice(0, 8).map((wf) => {
          const mine = runs.filter((r) => r.workflowId === wf.id);
          return (
            <li key={wf.id}>
              <Link
                href={`/workflows/${wf.id}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-t border-line px-5 py-3.5 transition-colors hover:bg-raised/40 sm:px-6 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_auto]"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <WorkflowDot wf={wf} />
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className={cn("truncate text-sm font-medium", !wf.enabled && "text-soft")}>{wf.name}</span>
                    <span className="truncate font-mono text-[11px] text-muted">
                      {wf.trigger.type === "schedule" ? wf.trigger.cron : TRIGGER[wf.trigger.type].toLowerCase()}
                      {" · "}
                      {wf.steps.length} {wf.steps.length === 1 ? "step" : "steps"}
                    </span>
                  </div>
                </div>
                <div className="hidden @2xl:block">
                  <Pipeline wf={wf} />
                </div>
                <div className="flex items-center gap-4">
                  <History runs={mine} />
                  <span className="hidden w-14 text-right font-mono text-[11px] text-muted sm:block">
                    {!wf.enabled ? "off" : wf.lastRun ? timeAgo(wf.lastRun.createdAt).replace(" ago", "") : "never"}
                  </span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ---------- Latest runs, as a timeline ---------- */

function Feed({ runs, count }: { runs: Run[]; count: number }) {
  return (
    <section className="rounded-2xl border border-line bg-graphite">
      <PanelHead title="Latest runs" href="/runs" label="All runs" />
      {runs.length === 0 ? (
        <p className="border-t border-line px-5 py-6 text-sm text-muted sm:px-6">No runs yet. Open a workflow and press Run.</p>
      ) : (
        <ol className="relative border-t border-line px-5 py-3 sm:px-6">
          <span className="absolute top-6 bottom-6 left-[calc(1.25rem+3.5px)] w-px bg-line sm:left-[calc(1.5rem+3.5px)]" aria-hidden="true" />
          {runs.slice(0, count).map((r) => {
            const k = kindOf(r.status);
            return (
              <li key={r.id}>
                <Link href={`/runs/${r.id}`} className="group relative flex items-start gap-4 py-2.5">
                  <span className={cn("relative mt-1.5 size-2 shrink-0 rounded-full ring-4 ring-graphite", FILL[k], k === "pass" && "bg-edge")} />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-[13px] font-medium transition-colors group-hover:text-spark">{r.workflowName}</span>
                    <span className="truncate font-mono text-[11px] text-muted">
                      {r.triggerType} · {timeAgo(r.createdAt)}
                      {r.finishedAt ? ` · ${duration(r.finishedAt - r.createdAt)}` : ""}
                    </span>
                  </div>
                  <span className={cn("mt-0.5 shrink-0 font-mono text-[11px]", WORD[k].color)}>{WORD[k].text}</span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/* ---------- First visit ---------- */

function Welcome() {
  const editable = canEdit(useSession().workspace.role);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");
  async function useExample(i: number) {
    setBusy(i);
    try {
      const wf = await api.createWorkflow(EXAMPLES[i].workflow);
      navigate(`/workflows/${wf.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-5">
        <p className={eyebrow}>{new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p>
        <h1 className="font-display text-[40px] leading-[44px] font-bold tracking-[-0.04em] sm:text-[56px] sm:leading-[56px]">
          <span className="block text-text">Nothing is wired</span>
          <span className="block text-muted">
            up yet<span className="text-spark">.</span>
          </span>
        </h1>
        <p className="max-w-xl text-[15px] leading-relaxed text-soft">
          {editable
            ? "Wire a webhook, a schedule or a button to a few steps. Start from an example below and you will see your first run in under a minute."
            : "You're a viewer here. Workflows and runs show up on this page once the owner or an editor adds them."}
        </p>
        <div className={cn("flex flex-wrap gap-3", !editable && "hidden")}>
          <Link
            href="/workflows/new"
            className="inline-flex h-11 items-center gap-2 rounded-full bg-text px-5 text-sm font-semibold text-ink transition-colors hover:bg-soft"
          >
            <PlusIcon className="size-4" />
            New workflow
          </Link>
        </div>
      </div>

      <RunBoard runs={[]} empty />

      {error && <p className="text-fail">{error}</p>}
      <section className={cn("flex flex-col gap-4", !editable && "hidden")} aria-labelledby="examples">
        <h2 id="examples" className={eyebrow}>
          Start from an example
        </h2>
        <div className="grid gap-4 lg:grid-cols-3">
          {EXAMPLES.map((ex, i) => (
            <button
              key={ex.title}
              type="button"
              onClick={() => useExample(i)}
              disabled={busy !== null}
              className="group flex flex-col gap-4 rounded-2xl border border-line bg-graphite p-5 text-left transition-colors hover:border-edge disabled:opacity-60"
            >
              <Pipeline wf={ex.workflow} />
              <div className="flex flex-col gap-1.5">
                <span className="font-medium">{ex.title}</span>
                <span className="text-sm text-soft">{ex.blurb}</span>
              </div>
              <span className="mt-auto inline-flex items-center gap-1 text-[13px] text-muted transition-colors group-hover:text-text">
                {busy === i ? "Creating…" : "Use this"}
                <ArrowIcon className="size-4" />
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

const NOTICE_KEY = "knotwork.recoveryNoticeHidden";

/** New accounts have no recovery codes, and there is no email reset. A quiet nudge until they make some. */
function RecoveryNotice() {
  const { me } = useSession();
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem(NOTICE_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (hidden || me.user.demo || me.recoveryCodesLeft > 0) return null;
  return (
    <div role="note" className="flex items-start gap-3 rounded-xl border border-line py-2 pr-2 pl-4 text-[13px] leading-5 text-soft">
      <span className="mt-[14px] size-2 shrink-0 rounded-full bg-retry" aria-hidden="true" />
      <p className="min-w-0 flex-1 py-2">
        No recovery codes yet. Without one, a lost password means a lost account.{" "}
        <Link href="/settings" className="whitespace-nowrap text-text underline decoration-edge underline-offset-4 hover:decoration-text">
          Make them in Settings
        </Link>
      </p>
      <button
        type="button"
        aria-label="Hide this notice"
        className="grid size-9 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-graphite hover:text-text"
        onClick={() => {
          setHidden(true);
          try {
            sessionStorage.setItem(NOTICE_KEY, "1");
          } catch {
            // Storage blocked: it stays hidden until the page reloads.
          }
        }}
      >
        <CloseIcon className="size-4" />
      </button>
    </div>
  );
}

export function HomePage() {
  return (
    <div className="flex flex-col gap-6">
      <RecoveryNotice />
      <HomeBody />
    </div>
  );
}

function HomeBody() {
  const { workflows, runs, error } = useWorkspace();

  if (error && !workflows) return <p className="text-fail">{error}</p>;
  if (!workflows || !runs)
    return (
      <div className="flex flex-col gap-10" aria-label="Loading">
        <div className="h-36 w-2/3 animate-pulse rounded-2xl bg-graphite" />
        <div className="h-28 animate-pulse rounded-2xl bg-graphite" />
        <div className="h-64 animate-pulse rounded-2xl bg-graphite" />
      </div>
    );
  if (workflows.length === 0) return <Welcome />;

  const day = runsSince(runs, DAY);
  return (
    <div className="flex flex-col gap-10">
      <Headline workflows={workflows} />
      <Stats runs={day} />
      <RunBoard runs={day} />
      <div className="grid items-start gap-6 xl:grid-cols-12">
        <div className="xl:col-span-8">
          <Workflows workflows={workflows} runs={runs} />
        </div>
        <div className="xl:col-span-4">
          <Feed runs={runs} count={Math.min(8, Math.max(5, Math.min(8, workflows.length) + 1))} />
        </div>
      </div>
    </div>
  );
}
