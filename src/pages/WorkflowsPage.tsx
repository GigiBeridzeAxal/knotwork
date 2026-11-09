import { useEffect, useState } from "react";
import type { WorkflowSummary } from "../../shared/schema";
import { api } from "../api";
import { PlusIcon } from "../components/icons";
import { Button, Card, Eyebrow, PageTitle, StatusBadge, timeAgo } from "../components/ui";
import { EXAMPLES } from "../../shared/examples";
import { Link, navigate } from "../router";

export function triggerLabel(wf: Pick<WorkflowSummary, "trigger">) {
  if (wf.trigger.type === "schedule") return `Schedule · ${wf.trigger.cron}`;
  if (wf.trigger.type === "webhook") return "Webhook";
  return "Manual";
}

export function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    api.workflows().then(setWorkflows, (e) => setError(e.message));
  }, []);

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
    <div className="flex flex-col gap-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <PageTitle>Workflows</PageTitle>
          <p className="text-soft">Wire a trigger to steps. Failed steps retry on their own, and every run is logged.</p>
        </div>
        <Link
          href="/workflows/new"
          className="inline-flex h-11 items-center gap-2 rounded-full bg-text px-5 text-sm font-semibold text-ink transition-colors hover:bg-soft"
        >
          <PlusIcon className="size-4" />
          New workflow
        </Link>
      </div>

      {error && <p className="text-fail">{error}</p>}

      {workflows && workflows.length > 0 && (
        <ul className="grid gap-4 md:grid-cols-2">
          {workflows.map((wf) => (
            <li key={wf.id}>
              <Link href={`/workflows/${wf.id}`} className="block h-full">
                <Card className="flex h-full flex-col gap-4 p-5 transition-colors hover:border-edge">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-1">
                      <Eyebrow>{triggerLabel(wf)}</Eyebrow>
                      <h2 className="truncate text-lg font-semibold">{wf.name}</h2>
                    </div>
                    {!wf.enabled && <span className="rounded-full bg-muted/12 px-3 py-1 text-xs text-soft">Off</span>}
                  </div>
                  {wf.description && <p className="line-clamp-2 text-sm text-soft">{wf.description}</p>}
                  <div className="mt-auto flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
                    <span>
                      {wf.steps.length} {wf.steps.length === 1 ? "step" : "steps"}
                    </span>
                    {wf.lastRun ? (
                      <span className="flex items-center gap-2">
                        <StatusBadge status={wf.lastRun.status} error={wf.lastRun.error} />
                        {timeAgo(wf.lastRun.createdAt)}
                      </span>
                    ) : (
                      <span>Never run</span>
                    )}
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {workflows && workflows.length === 0 && (
        <Card className="dots flex flex-col items-center gap-3 px-6 py-14 text-center">
          <p className="font-display text-2xl font-bold">No workflows yet</p>
          <p className="max-w-md text-soft">Start from scratch, or pick an example below and run it straight away.</p>
        </Card>
      )}

      <section className="flex flex-col gap-4" aria-labelledby="examples">
        <h2 id="examples" className="font-display text-xl font-bold tracking-tight">
          Start from an example
        </h2>
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
      </section>
    </div>
  );
}
