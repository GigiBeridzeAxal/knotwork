import { useCallback, useEffect, useState } from "react";
import { LIMITS } from "../../../shared/limits";
import type { Member, MemberRole, NewInvite, Team } from "../../../shared/schema";
import { api } from "../../api";
import { Avatar } from "../../components/AppShell";
import { Button, Card, cn, inputClass } from "../../components/ui";
import { navigate } from "../../router";
import { useSession } from "../../session";
import { Count, day, errorText, RevealPanel, ROLE_CAN, ROLE_LABEL, SecretField, timeUntil } from "./parts";

const selectClass = cn(inputClass, "w-auto pr-8");

/** Who is in the current workspace. The owner manages roles and invite links; anyone else can leave. */
export function Members() {
  const { me, workspace, reload } = useSession();
  const [team, setTeam] = useState<Team | null>(null);
  const [error, setError] = useState("");
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const owner = workspace.role === "owner";

  const load = useCallback(() => {
    api.team(workspace.id).then(
      (t) => {
        setTeam(t);
        setError("");
      },
      (e) => setError(errorText(e)),
    );
  }, [workspace.id]);

  useEffect(load, [load]);

  async function changeRole(m: Member, role: MemberRole) {
    setBusy(m.userId);
    setRowError(null);
    try {
      await api.changeRole(workspace.id, m.userId, role);
      setTeam((t) => t && { ...t, members: t.members.map((x) => (x.userId === m.userId ? { ...x, role } : x)) });
    } catch (e) {
      setRowError({ id: m.userId, text: errorText(e) });
    } finally {
      setBusy("");
    }
  }

  async function remove(m: Member) {
    if (!confirm(`Remove ${m.name} from ${workspace.name}? They lose access right away, and API keys they made for it stop working. If they were an editor they have seen the webhook URLs: make new URLs in the editor for workflows they shouldn't be able to start.`)) return;
    setBusy(m.userId);
    setRowError(null);
    try {
      await api.removeMember(workspace.id, m.userId);
      setTeam((t) => t && { ...t, members: t.members.filter((x) => x.userId !== m.userId) });
    } catch (e) {
      setRowError({ id: m.userId, text: errorText(e) });
    } finally {
      setBusy("");
    }
  }

  async function leave() {
    if (!confirm(`Leave ${workspace.name}? Your API keys for it are deleted, and you'll need a new invite link to join again.`)) return;
    setBusy("leave");
    try {
      await api.removeMember(workspace.id, me.user.id);
      await reload(me.workspaces.find((w) => w.personal)?.id);
      navigate("/home");
    } catch (e) {
      setError(errorText(e));
      setBusy("");
    }
  }

  if (error && !team) return <p className="text-sm text-fail">{error}</p>;
  if (!team) return <div className="h-40 animate-pulse rounded-2xl bg-graphite" aria-label="Loading members" />;

  const others = team.members.filter((m) => m.role !== "owner").length;

  return (
    <>
      <Card>
        <div className="flex items-center justify-between gap-4 px-5 pt-4 pb-3 sm:px-6">
          <span className="text-[13px] text-soft">People in {workspace.name}</span>
          <Count used={others} max={LIMITS.membersPerWorkspace} noun="members" />
        </div>
        <ul aria-label="Members">
          {team.members.map((m) => {
            const manage = owner && m.role !== "owner";
            return (
              <li key={m.userId} className="flex flex-col gap-2 border-t border-line px-5 py-3 sm:px-6">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                  <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
                    <Avatar name={m.name} />
                    <div className="flex min-w-0 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">{m.name}</span>
                        {m.you && <span className="shrink-0 rounded-full bg-raised px-2 py-0.5 font-mono text-[11px] text-soft">you</span>}
                      </span>
                      <span className="truncate text-xs text-muted">{m.role === "owner" ? "Made this workspace" : `Joined ${day(m.joinedAt)}`}</span>
                    </div>
                  </div>
                  {manage ? (
                    <div className="flex items-center gap-2">
                      <select
                        aria-label={`Permissions for ${m.name}`}
                        className={cn(selectClass, "h-9")}
                        value={m.role}
                        disabled={busy === m.userId}
                        onChange={(e) => changeRole(m, e.target.value as MemberRole)}
                      >
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                      </select>
                      <Button variant="ghost" className="h-9 px-3 hover:text-fail" disabled={busy === m.userId} onClick={() => remove(m)}>
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <span className="font-mono text-xs text-soft">{ROLE_LABEL[m.role]}</span>
                  )}
                </div>
                {rowError?.id === m.userId && <p className="text-[13px] text-fail">{rowError.text}</p>}
              </li>
            );
          })}
        </ul>
        {!owner && (
          <div className="flex flex-col gap-3 border-t border-line px-5 py-4 sm:flex-row sm:items-center sm:px-6">
            <p className="text-[13px] text-muted">
              {workspace.role === "editor"
                ? "You're an editor here, so you can change workflows and start runs."
                : "You're a viewer here, so you can look at workflows and runs but not change or run them."}
            </p>
            <Button variant="danger" className="shrink-0 sm:ml-auto" disabled={busy === "leave"} onClick={leave}>
              Leave workspace
            </Button>
          </div>
        )}
        {error && team && <p className="border-t border-line px-5 py-3 text-[13px] text-fail sm:px-6">{error}</p>}
      </Card>

      {owner && !me.user.demo && <Invites team={team} full={others >= LIMITS.membersPerWorkspace} onChange={load} />}
      {owner && me.user.demo && <p className="text-[13px] text-muted">The shared demo account can't invite people. Create your own account to share a workspace.</p>}
    </>
  );
}

function Invites({ team, full, onChange }: { team: Team; full: boolean; onChange: () => void }) {
  const { workspace } = useSession();
  const [role, setRole] = useState<MemberRole>("editor");
  const [made, setMade] = useState<NewInvite | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const atLimit = team.invites.length >= LIMITS.invitesPerWorkspace;

  async function create() {
    setBusy("create");
    setError("");
    try {
      setMade(await api.createInvite(workspace.id, role));
      onChange();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }

  async function revoke(id: string) {
    setBusy(id);
    setError("");
    try {
      await api.revokeInvite(workspace.id, id);
      if (made?.id === id) setMade(null);
      onChange();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <Card className="flex flex-col gap-5 p-5 sm:p-6">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">Invite people</h3>
        <p className="text-[13px] text-muted">
          Make a link and send it to someone. It works for {LIMITS.inviteDays} days or {LIMITS.inviteUses} people, whichever comes first.
        </p>
      </div>

      {made ? (
        <RevealPanel
          title={`Invite link for ${made.role === "editor" ? "editors" : "viewers"}`}
          note="Copy it now. For safety only a fingerprint is kept, so the link can't be shown again."
          onDone={() => setMade(null)}
        >
          <SecretField id="invite-link" label="Invite link" value={`${location.origin}/join/${made.token}`} />
        </RevealPanel>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-2">
            <label htmlFor="invite-role" className="text-[13px] text-soft">
              Role
            </label>
            <select id="invite-role" className={cn(selectClass, "sm:w-44")} value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          <Button variant="primary" className="shrink-0" disabled={busy === "create" || atLimit || full} onClick={create}>
            {busy === "create" ? "Creating…" : "Create invite link"}
          </Button>
          <p className="text-[13px] text-muted sm:pb-3">{ROLE_CAN[role]}</p>
        </div>
      )}
      {full && !made && <p className="text-[13px] text-retry">This workspace is full at {LIMITS.membersPerWorkspace} members. Remove someone to invite more.</p>}
      {atLimit && !full && !made && <p className="text-[13px] text-retry">{LIMITS.invitesPerWorkspace} open links is the limit. Revoke one to make another.</p>}
      {error && <p className="text-[13px] text-fail">{error}</p>}

      <div className="flex flex-col gap-2 border-t border-line pt-5">
        <div className="flex items-center justify-between gap-4">
          <span className="text-[13px] text-soft">Open links</span>
          <Count used={team.invites.length} max={LIMITS.invitesPerWorkspace} noun="links" />
        </div>
        {team.invites.length === 0 ? (
          <p className="text-[13px] text-muted">No open links. New ones show up here, without the link itself.</p>
        ) : (
          <ul aria-label="Open invite links" className="flex flex-col">
            {team.invites.map((inv) => (
              <li key={inv.id} className="flex items-center gap-4 border-t border-line py-2 first:border-0">
                <div className="flex min-w-0 flex-1 flex-col gap-x-4 gap-y-0.5 sm:flex-row sm:items-center">
                  <span className="text-sm font-medium sm:w-14">{ROLE_LABEL[inv.role]}</span>
                  <span className="font-mono text-xs text-muted tabular-nums">
                    {inv.uses} / {inv.maxUses} used · expires {timeUntil(inv.expiresAt)}
                  </span>
                </div>
                <Button variant="ghost" className="h-9 shrink-0 px-3 hover:text-fail" disabled={busy === inv.id} onClick={() => revoke(inv.id)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
