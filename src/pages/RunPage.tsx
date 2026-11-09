import { useEffect, useState } from "react";
import { canEdit, type RunDetail } from "../../shared/schema";
import { api, ApiError } from "../api";
import { Button, Card, cn, duration, Eyebrow, Json, StatusBadge, timeAgo } from "../components/ui";
import { Link, navigate } from "../router";
import { useFindElsewhere, useSession } from "../session";

const DONE = new Set(["succeeded", "failed", "stopped"]);

export function RunPage({ id }: { id: string }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState("");
  /** The last refresh failed for a passing reason (the server is busy or restarting); it is tried again. */
  const [retrying, setRetrying] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [nudging, setNudging] = useState(false);
  const [rerun, setRerun] = useState<{ busy: boolean; error: string }>({ busy: false, error: "" });
  const findElsewhere = useFindElsewhere();
  const editable = canEdit(useSession().workspace.role);

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
        setRetrying("");
        // Poll quickly while a run is moving, slowly while it waits for a delay or retry, and not
        // at all while the tab is hidden.
        if (!DONE.has(next.status)) schedule(next.status === "waiting" ? 30_000 : 3000);
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && e.status === 404 && (await findElsewhere("run", id))) return;
        // Not found or signed out ends it. Anything else (a 503 during a deploy, a 429, the network)
        // passes: keep what is on screen and try again.
        if (e instanceof ApiError && (e.status === 404 || e.status === 401)) return setError(e.message);
        setRetrying((e as Error).message);
        schedule(15_000);
      }
    };
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, findElsewhere]);

  if (error) return <p className="text-fail">{error}</p>;
  if (!run) return retrying ? <p className="text-sm text-soft">Couldn't load this run just now. Trying again shortly.</p> : null;

  const done = run.logs.filter((l) => l.status === "ok" || l.status === "waiting").length;
  // With if and loop steps, how many lines are still to come depends on the data: show one, not a count.
  const remaining = DONE.has(run.status) ? 0 : run.blocks ? 1 : Math.max(0, run.stepCount - done);
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
          {editable && DONE.has(run.status) && run.input !== null && (
            <Button
              className="ml-auto"
              disabled={rerun.busy}
              title="Start a new run of this workflow, as it is now, with this run's input"
              onClick={async () => {
                setRerun({ busy: true, error: "" });
                try {
                  const { runId } = await api.rerun(id);
                  navigate(`/runs/${runId}`);
                } catch (e) {
                  setRerun({ busy: false, error: (e as Error).message });
                }
              }}
            >
              Run again
            </Button>
          )}
        </div>
        <p className="font-mono text-sm text-muted">
          {run.id} · {run.triggerType} · started {timeAgo(run.createdAt)}
          {total !== null && ` · took ${duration(total)}`}
          {run.rerunOf && (
            <>
              {" · again from "}
              <Link href={`/runs/${run.rerunOf}`} className="text-soft underline underline-offset-2 hover:text-text">
                {run.rerunOf}
              </Link>
            </>
          )}
        </p>
        {rerun.error && (
          <p className="text-fail" role="alert">
            {rerun.error}
          </p>
        )}
        {retrying && (
          <p role="status" className="text-sm text-soft">
            Couldn't refresh this run just now. Trying again shortly.
          </p>
        )}
        {run.status === "waiting" && run.nextRunAt && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-retry">
            {run.error
              ? run.error
              : `Continues around ${new Date(run.nextRunAt).toLocaleTimeString()} (${new Date(run.nextRunAt).toISOString().slice(11, 16)} UTC), on the next minute tick.`}
            {editable && (
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
            )}
          </div>
        )}
        {run.error && run.status !== "waiting" && <p className="text-fail">{run.error}</p>}
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <ol className="flex flex-col gap-3" aria-label="Step log">
          {run.logs.map((log, i) => (
            <li key={log.id} style={log.depth ? { marginLeft: `${Math.min(log.depth, 3) * 24}px` } : undefined}>
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
                    {log.pass && `${log.pass} · `}
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
