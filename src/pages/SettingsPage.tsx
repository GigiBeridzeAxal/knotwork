import { type FormEvent, type ReactNode, useState } from "react";
import { LIMITS } from "../../shared/limits";
import { api } from "../api";
import { Avatar } from "../components/AppShell";
import { Button, Card, inputClass, PageTitle } from "../components/ui";
import { navigate } from "../router";
import { useSession } from "../session";
import { useWorkspace } from "../workspace";

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

function WorkspaceSettings() {
  const { workspace, me, reload } = useSession();
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function rename(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote("");
    try {
      await api.renameWorkspace(workspace.id, name);
      await reload();
      setNote("Saved");
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete "${workspace.name}" with all its workflows and runs? This can't be undone.`)) return;
    setBusy(true);
    try {
      await api.deleteWorkspace(workspace.id);
      await reload(me.workspaces.find((w) => w.personal)?.id);
      navigate("/home");
    } catch (err) {
      setNote((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-5 p-5 sm:p-6">
      <form onSubmit={rename} className="flex flex-col gap-2">
        <label htmlFor="ws-name" className="text-[13px] text-soft">
          Workspace name
        </label>
        <div className="flex gap-2">
          <input id="ws-name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          <Button type="submit" disabled={busy || !name.trim() || name.trim() === workspace.name}>
            Rename
          </Button>
        </div>
        {note && <p className={note === "Saved" ? "text-[13px] text-soft" : "text-[13px] text-fail"}>{note}</p>}
      </form>
      {workspace.personal ? (
        <p className="text-[13px] text-muted">This is your personal workspace. Every account keeps one, so it can be renamed but not deleted.</p>
      ) : (
        <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center">
          <p className="text-[13px] text-muted">Deleting removes its workflows, their webhooks and every run.</p>
          <Button variant="danger" className="shrink-0 sm:ml-auto" disabled={busy} onClick={remove}>
            Delete workspace
          </Button>
        </div>
      )}
    </Card>
  );
}

export function SettingsPage() {
  const { workflows, runsThisHour } = useWorkspace();
  const { me, workspace, logout } = useSession();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <PageTitle>Settings</PageTitle>
        <p className="text-soft">Your account, this workspace and the free plan limits.</p>
      </div>

      <Section title="Account" blurb={me.user.demo ? "The shared demo account. It resets every day at 03:00 UTC." : "You sign in with this email and your password."}>
        <Card className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:p-6">
          <div className="flex min-w-0 items-center gap-4">
            <Avatar name={me.user.name} size="lg" />
            <div className="flex min-w-0 flex-col gap-1">
              <span className="truncate font-medium">{me.user.name}</span>
              <span className="truncate text-sm text-muted">{me.user.demo ? "Shared demo account" : me.user.email}</span>
            </div>
          </div>
          <Button
            className="shrink-0 sm:ml-auto"
            onClick={async () => {
              await logout();
              navigate("/login", { replace: true });
            }}
          >
            Log out
          </Button>
        </Card>
      </Section>

      <Section title="Workspace" blurb="Workspaces keep groups of workflows apart. Switch between them from the sidebar.">
        <WorkspaceSettings key={workspace.id} />
      </Section>

      <Section title="Free plan" blurb="Knotwork runs on free plans, so each account has limits that keep it fair for everyone.">
        <Card>
          <Row label={`Workflows in ${workspace.name}`} value={`${workflows?.length ?? 0} / ${LIMITS.workflowsPerWorkspace}`} />
          <Row label="Workspaces" value={`${me.workspaces.length} / ${LIMITS.workspacesPerAccount}`} />
          <Row label="Runs in the last hour (whole account)" value={`${runsThisHour} / ${LIMITS.runsPerAccountPerHour}`} />
          <Row label="Steps per workflow" value={`up to ${LIMITS.stepsPerWorkflow}`} />
          <Row label="Shortest schedule" value={`every ${LIMITS.minScheduleMinutes} min`} />
        </Card>
      </Section>

      <Section title="Data" blurb="What Knotwork keeps, and for how long.">
        <Card>
          <Row label="Run history" value={`${LIMITS.runHistoryDays} days`} />
          <Row label="Workflows" value="until you delete them" />
        </Card>
      </Section>
    </div>
  );
}
