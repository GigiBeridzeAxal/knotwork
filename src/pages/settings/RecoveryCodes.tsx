import { type FormEvent, useState } from "react";
import { LIMITS } from "../../../shared/limits";
import { api } from "../../api";
import { Button, Card, cn, Field, inputClass } from "../../components/ui";
import { useSession } from "../../session";
import { CopyButton, errorText, RevealPanel } from "./parts";

/**
 * There is no email reset, so recovery codes are the only way back in after a lost password.
 * Making a new set needs the password and replaces the old set.
 */
export function RecoveryCodes() {
  const { me, reload } = useSession();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const left = me.recoveryCodesLeft;

  async function make(e: FormEvent) {
    e.preventDefault();
    if (left > 0 && !confirm("Make new codes? The codes you have now will stop working.")) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.newRecoveryCodes(password);
      setCodes(res.codes);
      setPassword("");
      await reload().catch(() => {});
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function download(list: string[]) {
    const text = [
      "Knotwork recovery codes",
      `Account: ${me.user.email}`,
      `Made: ${new Date().toISOString().slice(0, 10)}`,
      "",
      `Each code works once. Use one at ${location.origin}/recover to set a new password.`,
      "",
      ...list,
      "",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "knotwork-recovery-codes.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (codes) {
    return (
      <RevealPanel
        title="Your new recovery codes"
        note="Save them somewhere safe, like a password manager. They won't be shown again, and your old codes stopped working."
        onDone={() => setCodes(null)}
      >
        <ul className="grid grid-cols-1 gap-2 rounded-xl border border-line bg-ink p-4 min-[420px]:grid-cols-2" aria-label="Recovery codes">
          {codes.map((c) => (
            <li key={c} data-testid="recovery-code" className="font-mono text-[15px] tracking-[0.04em] text-text tabular-nums">
              {c}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={codes.join("\n")} label="Copy all" />
          <Button onClick={() => download(codes)}>Download .txt</Button>
        </div>
      </RevealPanel>
    );
  }

  return (
    <Card className="flex flex-col gap-5 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", left <= 2 ? "bg-retry" : "bg-soft")} aria-hidden="true" />
        {left === 0 ? (
          <p className="text-sm text-soft">
            <span className="font-medium text-text">You have no recovery codes.</span> Knotwork never sends email, so if you lose your password without a
            code, the account can't be recovered.
          </p>
        ) : (
          <p className="text-sm text-soft">
            <span className="font-medium text-text">
              {left} of {LIMITS.recoveryCodes} codes left.
            </span>{" "}
            {left <= 2 ? "You're running low. Make a new set soon." : "Each one works once."}
          </p>
        )}
      </div>
      <form onSubmit={make} className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Field label="Password to confirm" htmlFor="codes-password" error={error || undefined}>
            <input
              id="codes-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        <Button type="submit" variant={left === 0 ? "primary" : "secondary"} className="shrink-0" disabled={busy || !password}>
          {busy ? "Making codes…" : "Make new codes"}
        </Button>
      </form>
    </Card>
  );
}
