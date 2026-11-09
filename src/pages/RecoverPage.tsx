import { type FormEvent, useEffect, useState } from "react";
import { PASSWORD_MIN } from "../../shared/schema";
import { api, ApiError } from "../api";
import { cn, Field, inputClass } from "../components/ui";
import { Link, navigate } from "../router";
import { useSession } from "../session";
import { AuthFrame, nextPath, pill } from "./AuthPage";

/** Sets a new password with a recovery code. There is no email reset, so this is the only way back in. */
export function RecoverPage() {
  const session = useSession();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    document.title = "Recover your account · Knotwork";
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setFieldErrors({});
    try {
      session.signedIn(await api.recover({ email, code, password }));
      // Someone who came from an invite link goes back to it.
      navigate(nextPath(), { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.issues?.length) {
        setFieldErrors(Object.fromEntries(err.issues.map((i) => [String(i.path[0]), i.message])));
      }
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthFrame>
      <div className="mx-auto flex w-full max-w-[400px] flex-col gap-8">
        <div className="flex flex-col gap-3">
          <h1 className="font-display text-[32px] leading-[1.1] font-bold tracking-tight text-balance sm:text-[40px]">Recover your account</h1>
          <p className="text-soft">Use one of your recovery codes to set a new password. Your other codes end too, so make a new set in Settings afterwards.</p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label="Email" htmlFor="email" error={fieldErrors.email}>
            <input
              id="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Recovery code" htmlFor="code" error={fieldErrors.code} hint="Looks like ABCD-EFGH-JKMN. Dashes and case don't matter.">
            <input
              id="code"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              required
              placeholder="ABCD-EFGH-JKMN"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={cn(inputClass, "font-mono tracking-[0.04em] placeholder:text-muted/60")}
            />
          </Field>
          <Field label="New password" htmlFor="password" error={fieldErrors.password} hint={`At least ${PASSWORD_MIN} characters.`}>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </Field>

          {error && !Object.keys(fieldErrors).length && (
            <p role="alert" className="text-[13px] text-fail">
              {error}
            </p>
          )}

          <button type="submit" disabled={busy} className={cn(pill, "mt-2 bg-text text-ink hover:bg-soft")}>
            {busy ? "Setting your password…" : "Set new password and log in"}
          </button>
          <p className="text-[13px] text-muted">This logs you out on every other device and revokes your API keys.</p>
        </form>

        <div className="flex flex-col gap-2 rounded-2xl border border-line p-5">
          <p className="text-sm font-medium">No code?</p>
          <p className="text-[13px] leading-relaxed text-muted">
            Codes are made in Settings, under Recovery codes, while you're logged in. Knotwork never sends email, so without a code the account can't be
            recovered.
          </p>
        </div>

        <p className="text-sm text-soft">
          Remembered it?{" "}
          <Link href={`/login${location.search.includes("next=") ? location.search : ""}`} className="font-medium text-text underline decoration-edge underline-offset-4 hover:decoration-text">
            Log in
          </Link>
        </p>
      </div>
    </AuthFrame>
  );
}
