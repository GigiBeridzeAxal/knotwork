import { type ReactNode, useState } from "react";
import { LIMITS } from "../../shared/limits";
import { workspaceId, workspaceLink } from "../api";
import { workspaceMark } from "../components/AppShell";
import { CopyIcon } from "../components/icons";
import { Card, PageTitle } from "../components/ui";
import { HOUR, runsSince, useWorkspace } from "../workspace";

function Section({ title, blurb, children }: { title: string; blurb: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-t border-line pt-8 lg:grid-cols-3 lg:gap-8">
      <div className="flex flex-col gap-2">
        <h2 className="font-display text-xl font-bold tracking-tight">{title}</h2>
        <p className="text-sm text-muted">{blurb}</p>
      </div>
      <div className="lg:col-span-2">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-line px-5 py-4 first:border-0">
      <span className="text-sm text-soft">{label}</span>
      <span className="text-right font-mono text-sm text-text tabular-nums">{value}</span>
    </div>
  );
}

export function SettingsPage() {
  const { workflows, runs } = useWorkspace();
  const [copied, setCopied] = useState(false);
  const mark = workspaceMark();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <PageTitle>Settings</PageTitle>
        <p className="text-soft">Your workspace, its share link and the free plan limits.</p>
      </div>

      <Section title="Workspace" blurb="There are no accounts. This browser holds a private workspace, and its id is the key to your workflows.">
        <Card className="flex flex-col gap-5 p-5 sm:p-6">
          <div className="flex items-center gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-spark font-mono text-base font-medium text-ink">{mark.letters}</span>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-medium">Guest workspace</span>
              <span className="truncate font-mono text-xs text-muted">{workspaceId}</span>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="ws-link" className="text-[13px] text-soft">
              Workspace link
            </label>
            <div className="flex gap-2">
              <input
                id="ws-link"
                readOnly
                value={workspaceLink()}
                onFocus={(e) => e.currentTarget.select()}
                className="h-11 min-w-0 flex-1 rounded-lg border border-edge bg-ink px-3 font-mono text-xs text-soft focus:border-wire focus:outline-none"
              />
              <button
                type="button"
                className="inline-flex h-11 shrink-0 items-center gap-2 rounded-lg border border-edge px-4 text-sm font-medium hover:border-muted hover:bg-ink"
                onClick={() =>
                  navigator.clipboard.writeText(workspaceLink()).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                }
              >
                <CopyIcon className="text-muted" />
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="text-[13px] text-muted">Open it on another device to use the same workspace. Anyone with this link can edit your workflows.</p>
          </div>
        </Card>
      </Section>

      <Section title="Free plan" blurb="Knotwork runs on Cloudflare's free plan, so each workspace has limits that keep it fair for everyone.">
        <Card>
          <Row label="Workflows" value={`${workflows?.length ?? 0} / ${LIMITS.workflowsPerWorkspace}`} />
          <Row label="Runs in the last hour" value={`${runsSince(runs, HOUR).length} / ${LIMITS.runsPerWorkspacePerHour}`} />
          <Row label="Steps per workflow" value={`up to ${LIMITS.stepsPerWorkflow}`} />
          <Row label="Shortest schedule" value={`every ${LIMITS.minScheduleMinutes} min`} />
        </Card>
      </Section>

      <Section title="Data" blurb="What Knotwork keeps, and for how long.">
        <Card>
          <Row label="Run history" value="14 days" />
          <Row label="Idle workflows deleted after" value={`${LIMITS.idleWorkflowDays} days`} />
        </Card>
      </Section>
    </div>
  );
}
