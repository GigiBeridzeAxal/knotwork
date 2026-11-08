import { useState } from "react";
import type { Run } from "../../shared/schema";
import { api } from "../api";
import { ArrowIcon, PlusIcon } from "../components/icons";
import { Button, Card, cn, duration, Eyebrow, PageTitle, StatusBadge, timeAgo } from "../components/ui";
import { EXAMPLES } from "../examples";
import { Link, navigate } from "../router";
import { HOUR, runsSince, useWorkspace } from "../workspace";
import { triggerLabel } from "./WorkflowsPage";

const DAY = 24 * HOUR;

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "pass" | "fail" }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <Eyebrow>{label}</Eyebrow>
      <span
        className={cn(
          "font-display text-4xl leading-none font-bold tracking-tight tabular-nums",
          tone === "pass" && "text-pass",
          tone === "fail" && "text-fail",
        )}
      >
        {value}
      </span>
      <span className="text-sm text-muted">{sub}</span>
    </Card>
  );
}

/** Runs per hour for the last 24 hours, stacked passed / failed / other. */
function Activity({ runs }: { runs: Run[] }) {
  const now = Date.now();
  const end = Math.ceil(now / HOUR) * HOUR;
  const buckets = Array.from({ length: 24 }, (_, i) => ({ start: end - (24 - i) * HOUR, pass: 0, fail: 0, other: 0 }));
  for (const r of runs) {
    const i = Math.floor((r.createdAt - (end - DAY)) / HOUR);
    if (i < 0 || i > 23) continue;
    if (r.status === "succeeded") buckets[i].pass++;
    else if (r.status === "failed") buckets[i].fail++;
    else buckets[i].other++;
  }
  const max = Math.max(4, ...buckets.map((b) => b.pass + b.fail + b.other)) * 1.15;
  const H = 160;
  const bw = 100 / 24;
  const hour = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric" });

  return (
    <Card className="flex flex-col gap-6 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-xl font-bold tracking-tight">Activity</h2>
          <p className="text-sm text-muted">Runs per hour, last 24 hours</p>
        </div>
        <div className="flex items-center gap-4 text-xs text-soft">
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-pass" />
            Passed
          </span>
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-fail" />
            Failed
          </span>
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-muted" />
            Other
          </span>
        </div>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label="Runs per hour over the last 24 hours">
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <line key={f} x1="0" x2="100" y1={H - H * f + 0.5} y2={H - H * f + 0.5} stroke="var(--color-line)" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray="2 4" />
          ))}
          <line x1="0" x2="100" y1={H - 0.5} y2={H - 0.5} stroke="var(--color-edge)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {buckets.map((b, i) => {
            const x = i * bw + bw * 0.22;
            const w = bw * 0.56;
            let y = H;
            return (
              <g key={b.start}>
                <title>{`${hour(b.start)}: ${b.pass} passed, ${b.fail} failed, ${b.other} other`}</title>
                {(
                  [
                    [b.pass, "var(--color-pass)"],
                    [b.fail, "var(--color-fail)"],
                    [b.other, "var(--color-muted)"],
                  ] as const
                ).map(([n, c]) => {
                  if (!n) return null;
                  const h = (n / max) * H;
                  y -= h;
                  return <rect key={c} x={x} y={y} width={w} height={h} fill={c} />;
                })}
                {b.pass + b.fail + b.other === 0 && <rect x={x} y={H - 2} width={w} height={2} fill="var(--color-line)" />}
              </g>
            );
          })}
        </svg>
        <div className="mt-2 flex justify-between font-mono text-[11px] text-muted">
          <span>{hour(end - DAY)}</span>
          <span className="hidden sm:inline">{hour(end - 18 * HOUR)}</span>
          <span>{hour(end - 12 * HOUR)}</span>
          <span className="hidden sm:inline">{hour(end - 6 * HOUR)}</span>
          <span>Now</span>
        </div>
      </div>
    </Card>
  );
}

function SectionHead({ title, href, label }: { title: string; href: string; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 pt-5 pb-3 sm:px-6">
      <h2 className="font-display text-xl font-bold tracking-tight">{title}</h2>
      <Link href={href} className="flex items-center gap-1 text-sm text-soft hover:text-text">
        {label}
        <ArrowIcon className="size-4" />
      </Link>
    </div>
  );
}

function Welcome() {
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
    <div className="flex flex-col gap-6">
      <Card className="dots flex flex-col items-start gap-4 p-6 sm:p-10">
        <Eyebrow>Welcome to Knotwork</Eyebrow>
        <h2 className="max-w-xl font-display text-3xl font-bold tracking-tight">Build your first workflow</h2>
        <p className="max-w-xl text-soft">
          Wire a webhook, a schedule or a button to a few steps. When a step fails, Knotwork waits, tries again and logs every attempt. Your dashboard fills in
          here once runs start.
        </p>
        <Link
          href="/workflows/new"
          className="mt-2 inline-flex h-11 items-center gap-2 rounded-lg bg-spark px-5 text-sm font-semibold text-ink hover:bg-spark-hover"
        >
          <PlusIcon />
          New workflow
        </Link>
      </Card>
      {error && <p className="text-fail">{error}</p>}
      <div className="grid gap-4 md:grid-cols-3">
        {EXAMPLES.map((ex, i) => (
          <Card key={ex.title} className="flex flex-col gap-3 p-5">
            <Eyebrow>{triggerLabel(ex.workflow)}</Eyebrow>
            <h3 className="font-semibold">{ex.title}</h3>
            <p className="text-sm text-soft">{ex.blurb}</p>
            <Button className="mt-auto self-start" onClick={() => useExample(i)} disabled={busy !== null}>
              {busy === i ? "Creating…" : "Use this"}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function HomePage() {
  const { workflows, runs, error } = useWorkspace();
  const day = runsSince(runs, DAY);
  const passed = day.filter((r) => r.status === "succeeded").length;
  const failed = day.filter((r) => r.status === "failed").length;
  const live = day.filter((r) => ["queued", "running", "waiting"].includes(r.status)).length;
  const done = passed + failed;
  const enabled = workflows?.filter((w) => w.enabled).length ?? 0;
  const finished = day.filter((r) => r.finishedAt);
  const avg = finished.length ? finished.reduce((s, r) => s + (r.finishedAt! - r.createdAt), 0) / finished.length : 0;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <PageTitle>Home</PageTitle>
        <p className="text-soft">How your workflows did over the last 24 hours.</p>
      </div>

      {error && <p className="text-fail">{error}</p>}
      {!workflows && !error && <div className="h-64 animate-pulse rounded-2xl bg-graphite" aria-label="Loading" />}

      {workflows && workflows.length === 0 && <Welcome />}

      {workflows && workflows.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <Stat label="Runs · 24h" value={String(day.length)} sub={live ? `${live} in progress` : "None in progress"} />
            <Stat
              label="Success rate"
              value={done ? `${Math.round((passed / done) * 100)}%` : "—"}
              sub={done ? `${passed} of ${done} finished` : "No finished runs yet"}
              tone={done && passed === done ? "pass" : undefined}
            />
            <Stat label="Failed · 24h" value={String(failed)} sub={finished.length ? `Average run ${duration(Math.round(avg))}` : "Nothing to report"} tone={failed ? "fail" : undefined} />
            <Stat label="Workflows" value={`${enabled}/${workflows.length}`} sub="Switched on" />
          </div>

          <Activity runs={day} />

          <div className="grid gap-6 xl:grid-cols-5">
            <Card className="xl:col-span-3">
              <SectionHead title="Recent runs" href="/runs" label="All runs" />
              {runs && runs.length === 0 ? (
                <p className="px-5 pb-6 text-sm text-soft sm:px-6">No runs yet. Open a workflow and press Run.</p>
              ) : (
                <ul className="pb-2">
                  {(runs ?? []).slice(0, 6).map((r) => (
                    <li key={r.id}>
                      <Link href={`/runs/${r.id}`} className="flex items-center gap-4 border-t border-line px-5 py-3 hover:bg-ink/50 sm:px-6">
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="truncate text-sm font-medium">{r.workflowName}</span>
                          <span className="text-xs text-muted">
                            <span className="capitalize">{r.triggerType}</span> · {timeAgo(r.createdAt)}
                            {r.finishedAt ? ` · ${duration(r.finishedAt - r.createdAt)}` : ""}
                          </span>
                        </div>
                        <StatusBadge status={r.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="xl:col-span-2">
              <SectionHead title="Workflows" href="/workflows" label="All workflows" />
              <ul className="pb-2">
                {workflows.slice(0, 6).map((wf) => (
                  <li key={wf.id}>
                    <Link href={`/workflows/${wf.id}`} className="flex items-center gap-4 border-t border-line px-5 py-3 hover:bg-ink/50 sm:px-6">
                      <span
                        className={cn("size-2 shrink-0 rounded-full", !wf.enabled ? "bg-edge" : wf.lastRun?.status === "failed" ? "bg-fail" : wf.lastRun ? "bg-pass" : "bg-muted")}
                        aria-hidden="true"
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="truncate text-sm font-medium">{wf.name}</span>
                        <span className="truncate font-mono text-[11px] tracking-[0.06em] text-muted uppercase">{triggerLabel(wf)}</span>
                      </div>
                      <span className="shrink-0 text-xs text-muted">{!wf.enabled ? "Off" : wf.lastRun ? timeAgo(wf.lastRun.createdAt) : "Never run"}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
