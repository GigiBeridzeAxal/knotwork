import { type FormEvent, useEffect, useState } from "react";
import { LIMITS } from "../../../shared/limits";
import { type ApiKey, type ApiKeyAccess, canEdit, type NewApiKey } from "../../../shared/schema";
import { api } from "../../api";
import { Button, Card, cn, Field, inputClass, timeAgo } from "../../components/ui";
import { useSession } from "../../session";
import { CopyButton, Count, day, errorText, RevealPanel, SecretField } from "./parts";

export const API_DOCS = "https://github.com/GigiBeridzeAxal/knotwork/blob/main/docs/api.md";

/** Keys belong to the account, and each one works in a single workspace with at most its maker's rights. */
export function ApiKeys() {
  const { me, workspace } = useSession();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState("");
  const writable = canEdit(workspace.role);
  const [access, setAccess] = useState<ApiKeyAccess>("read");
  const [made, setMade] = useState<NewApiKey | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");

  useEffect(() => {
    api.apiKeys().then(setKeys, (e) => setListError(errorText(e)));
  }, []);

  const full = (keys?.length ?? 0) >= LIMITS.apiKeysPerAccount;
  /** A write key made by someone who is now a viewer only reads: a key never does more than its maker. */
  const viewerIn = (id: string) => me.workspaces.find((w) => w.id === id)?.role === "viewer";
  const wsName = (id: string) => me.workspaces.find((w) => w.id === id)?.name ?? "A workspace you left";

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy("create");
    setError("");
    try {
      const key = await api.createApiKey({ name, workspaceId: workspace.id, access: writable ? access : "read" });
      setMade(key);
      setKeys((k) => [...(k ?? []), key]);
      setName("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy("");
    }
  }

  async function revoke(k: ApiKey) {
    if (!confirm(`Revoke "${k.name}"? Anything using it stops working right away.`)) return;
    setBusy(k.id);
    setListError("");
    try {
      await api.revokeApiKey(k.id);
      setKeys((list) => (list ?? []).filter((x) => x.id !== k.id));
      if (made?.id === k.id) setMade(null);
    } catch (err) {
      setListError(errorText(err));
    } finally {
      setBusy("");
    }
  }

  const curl = (key: string) => `curl -H "Authorization: Bearer ${key}" ${location.origin}/api/workflows`;

  return (
    <>
      {made ? (
        <RevealPanel
          title={`"${made.name}" is ready`}
          note="Copy the key now. Only a fingerprint is kept, so it can't be shown again. Treat it like a password."
          onDone={() => setMade(null)}
        >
          <SecretField id="new-api-key" label="Your new API key" value={made.key} />
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-soft">Try it</span>
            <div className="flex flex-col gap-2 sm:flex-row">
              <code className="flex min-h-11 min-w-0 flex-1 items-center overflow-x-auto rounded-[10px] border border-line bg-ink px-3 py-2 font-mono text-[12.5px] whitespace-nowrap text-soft">
                {curl(made.key)}
              </code>
              <CopyButton text={curl(made.key)} label="Copy command" className="self-start sm:self-auto" />
            </div>
          </div>
        </RevealPanel>
      ) : (
        <Card className="p-5 sm:p-6">
          <form onSubmit={create} className="flex flex-col gap-4">
            <p className="text-[13px] text-muted">
              A new key works in <span className="text-soft">{workspace.name}</span> only. To use another workspace, switch to it first.
            </p>
            <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
              <Field label="Key name" htmlFor="key-name" hint="So you know where it's used, like “Deploy script”.">
                <input id="key-name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
              </Field>
              <Field
                label="Access"
                htmlFor="key-access"
                hint={writable ? (access === "write" ? "Can also change and run workflows." : "Can list workflows and runs.") : "Viewers can only make read keys."}
              >
                <select id="key-access" className={inputClass} value={writable ? access : "read"} onChange={(e) => setAccess(e.target.value as ApiKeyAccess)}>
                  <option value="read">Read only</option>
                  <option value="write" disabled={!writable}>
                    Read and write
                  </option>
                </select>
              </Field>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              {error && (
                <p role="alert" className="text-[13px] text-fail">
                  {error}
                </p>
              )}
              {full && !error && <p className="text-[13px] text-retry">{LIMITS.apiKeysPerAccount} keys is the limit. Revoke one to make another.</p>}
              <Button type="submit" className="shrink-0 sm:ml-auto" disabled={busy === "create" || !name.trim() || full}>
                {busy === "create" ? "Creating…" : "Create API key"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card>
        <div className="flex items-center justify-between gap-4 px-5 pt-4 pb-3 sm:px-6">
          <span className="text-[13px] text-soft">Your keys, in every workspace</span>
          {keys && <Count used={keys.length} max={LIMITS.apiKeysPerAccount} noun="keys" />}
        </div>
        {!keys && !listError && <div className="mx-5 mb-4 h-12 animate-pulse rounded-[10px] bg-raised/50 sm:mx-6" />}
        {keys?.length === 0 && <p className="border-t border-line px-5 py-4 text-[13px] text-muted sm:px-6">No keys yet.</p>}
        {keys && keys.length > 0 && (
          <ul aria-label="API keys">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center gap-4 border-t border-line px-5 py-3 sm:px-6">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">{k.name}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px]",
                        k.access === "write" ? "bg-raised text-text ring-1 ring-edge ring-inset" : "bg-raised text-soft",
                      )}
                    >
                      {k.access !== "write" ? "read only" : viewerIn(k.workspaceId) ? "read only while you're a viewer" : "read and write"}
                    </span>
                  </span>
                  <span className="truncate font-mono text-xs text-muted">
                    {k.prefix}… · {wsName(k.workspaceId)}
                  </span>
                  <span className="truncate font-mono text-xs text-muted tabular-nums">
                    made {day(k.createdAt)} · {k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"}
                  </span>
                </div>
                <Button variant="ghost" className="h-9 shrink-0 px-3 hover:text-fail" disabled={busy === k.id} onClick={() => revoke(k)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
        {listError && <p className="border-t border-line px-5 py-3 text-[13px] text-fail sm:px-6">{listError}</p>}
      </Card>
    </>
  );
}
