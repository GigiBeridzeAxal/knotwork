import { type FormEvent, useEffect, useState } from "react";
import { LIMITS } from "../../shared/limits";
import { canEdit, PASSWORD_MIN, SECRET_NAME, type SecretInfo } from "../../shared/schema";
import { api, ApiError } from "../api";
import { Avatar } from "../components/AppShell";
import { Button, Card, Field, inputClass, PageTitle, timeAgo } from "../components/ui";
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
    if (!confirm(`Delete "${workspace.name}" with all its workflows and runs? Everyone in it loses access and every API key for it stops working. This can't be undone.`)) return;
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

/**
 * The workspace's secrets: names only. A value can be replaced or deleted, never read back, so the
 * form that sets one is the last place it is visible.
 */
function SecretsSettings({ demo, readOnly }: { demo: boolean; readOnly: boolean }) {
  const [secrets, setSecrets] = useState<SecretInfo[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let stale = false;
    api.secrets().then(
      (list) => !stale && setSecrets(list),
      (err) => !stale && setNote({ ok: false, text: (err as Error).message }),
    );
    return () => {
      stale = true;
    };
  }, []);

  const exists = secrets?.some((x) => x.name === name) ?? false;
  const nameOk = SECRET_NAME.test(name);
  const full = (secrets?.length ?? 0) >= LIMITS.secretsPerWorkspace && !exists;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      await api.setSecret(name, value);
      setSecrets(await api.secrets());
      setNote({ ok: true, text: exists ? `${name} has its new value.` : `${name} is saved. Use it as {{ secrets.${name} }}.` });
      setName("");
      setValue("");
    } catch (err) {
      const issue = err instanceof ApiError && err.status === 400 ? err.issues[0]?.message : undefined;
      setNote({ ok: false, text: issue ?? (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function remove(secret: string) {
    if (!confirm(`Delete ${secret}? Steps that use {{ secrets.${secret} }} will fail until it is added again.`)) return;
    setBusy(true);
    setNote(null);
    try {
      await api.deleteSecret(secret);
      setSecrets(await api.secrets());
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      {secrets && secrets.length > 0 && (
        <ul aria-label="Secrets">
          {secrets.map((x) => (
            <li key={x.name} className="flex min-h-14 items-center gap-3 border-b border-line py-2 pr-2 pl-5">
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{x.name}</span>
              <span className="hidden text-[13px] text-muted sm:block">set {timeAgo(x.updatedAt)}</span>
              {!demo && !readOnly && (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setName(x.name);
                      setValue("");
                      setNote(null);
                      document.getElementById("secret-value")?.focus();
                    }}
                  >
                    Replace
                  </Button>
                  <Button variant="ghost" className="text-fail hover:text-fail" disabled={busy} aria-label={`Delete ${x.name}`} onClick={() => remove(x.name)}>
                    Delete
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {readOnly && !demo ? (
        <p className="p-5 text-[13px] text-muted sm:p-6">
          {secrets?.length === 0 ? "This workspace has no secrets. " : ""}Viewers can see which secrets exist, but not set or delete them.
        </p>
      ) : demo ? (
        <p className="p-5 text-[13px] text-muted sm:p-6">
          The demo account is shared with everyone who opens it, so it can't keep secrets. Create a free account to use them.
        </p>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-4 p-5 sm:p-6">
          {secrets?.length === 0 && (
            <p className="text-[13px] text-muted">
              No secrets yet. Add an API key or token here, and steps can use it as <code className="font-mono text-soft">{"{{ secrets.NAME }}"}</code> without it being part of the workflow.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="secret-name" error={name && !nameOk ? "Capital letters, digits and _, starting with a letter" : undefined}>
              <input
                id="secret-name"
                maxLength={40}
                placeholder="SLACK_URL"
                autoComplete="off"
                spellCheck={false}
                value={name}
                onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
                className={`${inputClass} font-mono`}
              />
            </Field>
            <Field label={exists ? "New value" : "Value"} htmlFor="secret-value" hint={`${LIMITS.secretMinChars} characters or more. It can't be shown again after saving.`}>
              <input
                id="secret-value"
                type="password"
                autoComplete="off"
                maxLength={LIMITS.secretMaxChars}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className={`${inputClass} font-mono`}
              />
            </Field>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <p className={note ? (note.ok ? "text-[13px] text-soft" : "text-[13px] text-fail") : "text-[13px] text-muted"} role="status">
              {note ? note.text : full ? `This workspace has its ${LIMITS.secretsPerWorkspace} secrets. Delete one to add another.` : ""}
            </p>
            <Button type="submit" className="shrink-0 sm:ml-auto" disabled={busy || !nameOk || value.length < LIMITS.secretMinChars || full}>
              {exists ? "Replace value" : "Add secret"}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

/** Changing the password needs the current one, signs out every other device, and ends the account's API keys and recovery codes. */
function PasswordSettings({ onChanged }: { onChanged: () => void }) {
  const { reload } = useSession();
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
      // The change ended the account's recovery codes and API keys: show both sections as they are now.
      await reload().catch(() => {});
      onChanged();
      setNote({ ok: true, text: "Password changed. Other devices were logged out, and your API keys and recovery codes were ended. Make new recovery codes below." });
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
          Deletes your account, every workspace, workflow, webhook and run, and your API keys. People in your workspaces lose access. Your email can be used to sign up again afterwards.
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
  const [passwordChanges, setPasswordChanges] = useState(0);

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
        <Section title="Password" blurb="Changing it logs you out everywhere else, and ends your API keys and recovery codes.">
          <PasswordSettings onChanged={() => setPasswordChanges((n) => n + 1)} />
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
        title="Secrets"
        blurb={`API keys and tokens for ${workspace.name}'s workflows. They are stored encrypted, hidden in run logs, and never shown again.`}
      >
        <SecretsSettings key={workspace.id} demo={me.user.demo} readOnly={!canEdit(workspace.role)} />
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
          <ApiKeys key={`${workspace.id}:${passwordChanges}`} />
        </Section>
      )}

      <Section title="Free plan" blurb="Knotwork runs on free plans, so each account has limits that keep it fair for everyone.">
        <Card>
          <Row label={`Workflows in ${workspace.name}`} value={`${workflows?.length ?? 0} / ${LIMITS.workflowsPerWorkspace}`} />
          <Row label="Your workspaces" value={`${me.workspaces.filter((w) => w.role === "owner").length} / ${LIMITS.workspacesPerAccount}`} />
          <Row label={workspace.role === "owner" ? "Runs this hour (whole account)" : "Runs this hour (owner's account)"} value={`${runsThisHour} / ${runsLimit}`} />
          <Row label="Steps per workflow" value={`up to ${LIMITS.stepsPerWorkflow}`} />
          <Row label="Items per loop" value={`up to ${LIMITS.loopItems}`} />
          <Row label="Steps one run can take" value={`up to ${LIMITS.stepRunsPerRun}`} />
          <Row label="Secrets per workspace" value={`up to ${LIMITS.secretsPerWorkspace}`} />
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
