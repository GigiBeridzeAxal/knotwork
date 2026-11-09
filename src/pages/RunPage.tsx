import { useEffect, useState } from "react";
import type { RunDetail } from "../../shared/schema";
import { api, ApiError } from "../api";
import { Button, Card, cn, duration, Eyebrow, Json, StatusBadge, timeAgo } from "../components/ui";
import { Link } from "../router";
import { useFindElsewhere } from "../session";

const DONE = new Set(["succeeded", "failed", "stopped"]);

export function RunPage({ id }: { id: string }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [nudging, setNudging] = useState(false);
  const findElsewhere = useFindElsewhere();

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (ms: number) => {
      timer = setTimeout(() => (document.visibilityState === "visible" ? load() : schedule(ms)), ms);
    };
    const load = async () => {
      try {
        const next = await api.run(id);
        if (stopped) return;
        setRun(next);
        // Poll quickly while a run is moving, slowly while it waits for a delay or retry, and not
        // at all while the tab is hidden.
        if (!DONE.has(next.status)) schedule(next.status === "waiting" ? 30_000 : 3000);
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && e.status === 404 && (await findElsewhere("run", id))) return;
        setError((e as Error).message);
      }
    };
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, findElsewhere]);

  if (error) return <p className="text-fail">{error}</p>;
  if (!run) return null;

  const done = run.logs.filter((l) => l.status === "ok" || l.status === "waiting").length;
  const remaining = DONE.has(run.status) ? 0 : Math.max(0, run.stepCount - done);
  const total = run.finishedAt ? run.finishedAt - run.createdAt : null;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Link href={`/workflows/${run.workflowId}`} className="text-sm text-soft hover:text-text">
          ← {run.workflowName ?? "Workflow"}
        </Link>
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">Run</h1>
          <StatusBadge status={run.status} error={run.error} />
        </div>
        <p className="font-mono text-sm text-muted">
          {run.id} · {run.triggerType} · started {timeAgo(run.createdAt)}
          {total !== null && ` · took ${duration(total)}`}
        </p>
        {run.status === "waiting" && run.nextRunAt && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-retry">
            Continues around {new Date(run.nextRunAt).toLocaleTimeString()}, on the next minute tick.
            <Button
              variant="ghost"
              disabled={nudging}
              onClick={async () => {
                setNudging(true);
                const fresh = await api.checkRun(id).catch(() => null);
                if (fresh) setRun(fresh);
                setNudging(false);
              }}
            >
              Check now
            </Button>
          </div>
        )}
        {run.error && <p className="text-fail">{run.error}</p>}
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <ol className="flex flex-col gap-3" aria-label="Step log">
          {run.logs.map((log, i) => (
            <li key={log.id}>
              <Card className={cn(open === i && "border-edge")}>
                <button
                  type="button"
                  aria-expanded={open === i}
                  onClick={() => setOpen(open === i ? null : i)}
                  className="flex w-full flex-wrap items-center gap-3 p-4 text-left"
                >
                  <StatusBadge status={log.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{log.stepName}</span>
                    {log.message && <span className="block font-mono text-xs break-words text-soft">{log.message}</span>}
                  </span>
                  <span className="font-mono text-xs text-muted">
                    {log.attempt > 1 && `try ${log.attempt} · `}
                    {duration(log.durationMs)}
                  </span>
                </button>
                {open === i && (
                  <div className="border-t border-line p-4">
                    <Eyebrow>Output · steps.{log.stepId}</Eyebrow>
                    <div className="mt-2">
                      <Json value={log.output ?? undefined} />
                    </div>
                  </div>
                )}
              </Card>
            </li>
          ))}
          {Array.from({ length: remaining }).map((_, i) => (
            <li key={`pending-${i}`}>
              <div className="rounded-2xl border border-dashed border-line p-4 text-sm text-muted">
                {i === 0 && run.status === "running" ? "Running…" : "Not started yet"}
              </div>
            </li>
          ))}
          {run.logs.length === 0 && remaining === 0 && (
            <p className="text-muted">
              {run.status === "stopped" && run.error ? "The rest of this run was removed to free space." : "This workflow has no steps."}
            </p>
          )}
        </ol>

        <aside className="flex flex-col gap-3">
          <Eyebrow>Trigger input</Eyebrow>
          <Json value={run.input} />
        </aside>
      </div>
    </div>
  );
}
