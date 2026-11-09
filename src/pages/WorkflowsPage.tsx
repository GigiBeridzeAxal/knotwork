import { useEffect, useState } from "react";
import type { WorkflowSummary } from "../../shared/schema";
import { api } from "../api";
import { PlusIcon } from "../components/icons";
import { Card, Eyebrow, PageTitle, StatusBadge, timeAgo } from "../components/ui";
import { TEMPLATES } from "../../shared/templates";
import { ImportButton } from "./TemplatesPage";
import { Link } from "../router";

export function triggerLabel(wf: Pick<WorkflowSummary, "trigger">) {
  if (wf.trigger.type === "schedule") return `Schedule · ${wf.trigger.cron}`;
  if (wf.trigger.type === "webhook") return "Webhook";
  return "Manual";
}

export function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.workflows().then(setWorkflows, (e) => setError(e.message));
  }, []);

  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <PageTitle>Workflows</PageTitle>
          <p className="text-soft">Wire a trigger to steps. Failed steps retry on their own, and every run is logged.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ImportButton onError={setError} />
          <Link
            href="/workflows/new"
            className="inline-flex h-11 items-center gap-2 rounded-full bg-text px-5 text-sm font-semibold text-ink transition-colors hover:bg-soft"
          >
            <PlusIcon className="size-4" />
            New workflow
          </Link>
        </div>
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
          <p className="max-w-md text-soft">Start from scratch, or open a template below and run it straight away.</p>
        </Card>
      )}

      <section className="flex flex-col gap-4" aria-labelledby="templates">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="templates" className="font-display text-xl font-bold tracking-tight">
            Start from a template
          </h2>
          <Link href="/templates" className="text-sm text-soft hover:text-text">
            All {TEMPLATES.length} templates
          </Link>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {TEMPLATES.slice(0, 3).map((t) => (
            <Card key={t.id} className="flex flex-col gap-3 p-5">
              <Eyebrow>{triggerLabel(t.workflow)}</Eyebrow>
              <h3 className="font-semibold">{t.title}</h3>
              <p className="text-sm text-soft">{t.blurb}</p>
              <Link
                href={`/workflows/new?template=${t.id}`}
                className="mt-auto inline-flex h-11 items-center self-start rounded-[10px] border border-edge px-4 text-sm font-medium transition-colors hover:border-muted hover:bg-graphite"
              >
                Use this
              </Link>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
