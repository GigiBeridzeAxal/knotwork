import { type FormEvent, useState } from "react";
import { LIMITS } from "../../shared/limits";
import { PASSWORD_MIN } from "../../shared/schema";
import { api, ApiError } from "../api";
import { Avatar } from "../components/AppShell";
import { Button, Card, Field, inputClass, PageTitle } from "../components/ui";
import { navigate } from "../router";
import { useSession } from "../session";
import { useWorkspace } from "../workspace";
import { API_DOCS, ApiKeys } from "./settings/ApiKeys";
import { Members } from "./settings/Members";
import { Row, ROLE_LABEL, Section } from "./settings/parts";
import { RecoveryCodes } from "./settings/RecoveryCodes";

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

  if (workspace.role !== "owner") {
    return (
      <Card>
        <Row label="Workspace name" value={<span className="font-sans">{workspace.name}</span>} />
        <Row label="Your role" value={<span className="font-sans">{ROLE_LABEL[workspace.role]}</span>} />
        <p className="border-t border-line px-5 py-4 text-[13px] text-muted">Only the owner can rename or delete this workspace.</p>
      </Card>
    );
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

/** Changing the password needs the current one, and signs out every other device. */
function PasswordSettings() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setNote({ ok: true, text: "Password changed. Other devices were logged out and your API keys were revoked." });
    } catch (err) {
      const issue = err instanceof ApiError ? err.issues[0]?.message : undefined;
      setNote({ ok: false, text: issue && err instanceof ApiError && err.status === 400 ? issue : (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5 sm:p-6">
      <form onSubmit={save} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Current password" htmlFor="pw-current">
            <input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={inputClass} />
          </Field>
          <Field label="New password" htmlFor="pw-next" hint={`At least ${PASSWORD_MIN} characters`}>
            <input id="pw-next" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} value={next} onChange={(e) => setNext(e.target.value)} className={inputClass} />
          </Field>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {note && <p className={note.ok ? "text-[13px] text-soft" : "text-[13px] text-fail"} role="status">{note.text}</p>}
          <Button type="submit" className="shrink-0 sm:ml-auto" disabled={busy || !current || next.length < PASSWORD_MIN}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Deleting the account removes everything in it. The password confirms it's really the owner. */
function DeleteAccount() {
  const { logout } = useSession();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function remove(e: FormEvent) {
    e.preventDefault();
    if (!confirm("Delete your account with every workspace, workflow and run? This can't be undone.")) return;
    setBusy(true);
    setNote("");
    try {
      await api.deleteAccount(password);
      await logout();
      navigate("/login", { replace: true });
    } catch (err) {
      setNote((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Card className="p-5 sm:p-6">
      <form onSubmit={remove} className="flex flex-col gap-4">
        <p className="text-[13px] text-muted">
          Deletes your account, every workspace, workflow, webhook and run. Your email can be used to sign up again afterwards.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="Your password" htmlFor="delete-password" error={note || undefined}>
              <input id="delete-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
            </Field>
          </div>
          <Button type="submit" variant="danger" className="shrink-0" disabled={busy || !password}>
            Delete account
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function SettingsPage() {
  const { workflows, runsThisHour, runsLimit } = useWorkspace();
  const { me, workspace, logout } = useSession();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <PageTitle>Settings</PageTitle>
        <p className="text-soft">Your account, this workspace, the people in it and the free plan limits.</p>
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

      {!me.user.demo && (
        <Section title="Password" blurb="Changing it logs you out everywhere else and revokes your API keys.">
          <PasswordSettings />
        </Section>
      )}

      {!me.user.demo && (
        <Section
          title="Recovery codes"
          blurb="Knotwork never sends email. If you forget your password, one of these codes is the only way back in."
        >
          <RecoveryCodes />
        </Section>
      )}

      <Section title="Workspace" blurb="Workspaces keep groups of workflows apart. Switch between them from the sidebar.">
        <WorkspaceSettings key={workspace.id} />
      </Section>

      <Section
        title="Members"
        blurb="The owner manages who is in a workspace. Editors change workflows and start runs. Viewers only look, but they can read every step's settings, including anything pasted into headers."
      >
        {me.user.demo && workspace.personal ? (
          <Card className="p-5 sm:p-6">
            <p className="text-sm text-soft">The shared demo account can't share workspaces. Create your own account to invite people.</p>
          </Card>
        ) : workspace.personal ? (
          <Card className="p-5 sm:p-6">
            <p className="text-sm text-soft">
              <span className="font-medium text-text">Personal is only for you, so it can't be shared.</span> To work with other people, make a
              new workspace from the workspace menu in the sidebar, then invite them from here.
            </p>
          </Card>
        ) : (
          <Members key={workspace.id} />
        )}
      </Section>

      {!me.user.demo && (
        <Section
          title="API keys"
          blurb={
            <>
              <p>Let scripts and other services read or run your workflows. Changing or recovering your password revokes every key.</p>
              <a href={API_DOCS} target="_blank" rel="noreferrer" className="mt-2 inline-block text-soft underline decoration-edge underline-offset-4 hover:text-text hover:decoration-text">
                Read the API docs
              </a>
            </>
          }
        >
          <ApiKeys key={workspace.id} />
        </Section>
      )}

      <Section title="Free plan" blurb="Knotwork runs on free plans, so each account has limits that keep it fair for everyone.">
        <Card>
          <Row label={`Workflows in ${workspace.name}`} value={`${workflows?.length ?? 0} / ${LIMITS.workflowsPerWorkspace}`} />
          <Row label="Your workspaces" value={`${me.workspaces.filter((w) => w.role === "owner").length} / ${LIMITS.workspacesPerAccount}`} />
          <Row label="Runs this hour (whole account)" value={`${runsThisHour} / ${runsLimit}`} />
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

      {!me.user.demo && (
        <Section title="Delete account" blurb="Removes the account and everything in it, right away.">
          <DeleteAccount />
        </Section>
      )}
    </div>
  );
}
