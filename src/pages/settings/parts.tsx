import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Role } from "../../../shared/schema";
import { ApiError } from "../../api";
import { Button, cn } from "../../components/ui";

/** A settings block: title and a short why on the left, the controls on the right. */
export function Section({ title, blurb, children }: { title: string; blurb: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-t border-line pt-8 lg:grid-cols-3 lg:gap-8">
      <div className="flex flex-col gap-2">
        <h2 className="font-display text-xl font-bold tracking-tight">{title}</h2>
        <div className="text-sm text-muted">{blurb}</div>
      </div>
      <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">{children}</div>
    </section>
  );
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-line px-5 py-4 first:border-0">
      <span className="min-w-0 text-sm [overflow-wrap:anywhere] text-soft">{label}</span>
      <span className="shrink-0 text-right font-mono text-sm text-text tabular-nums">{value}</span>
    </div>
  );
}

/** A quiet "used / limit" counter for the top of a list. */
export function Count({ used, max, noun }: { used: number; max: number; noun: string }) {
  return (
    <span className={cn("font-mono text-xs tabular-nums", used >= max ? "text-retry" : "text-muted")}>
      {used} / {max} {noun}
    </span>
  );
}

/** The message to show for a failed request: the first field problem on a 400, else the server's message. */
export function errorText(err: unknown) {
  if (err instanceof ApiError && err.status === 400 && err.issues[0]?.message) return err.issues[0].message;
  return (err as Error).message;
}

/** A copy button that says "Copied" for a moment. The visible label is the accessible name. */
export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        );
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

/** A secret shown once: a readonly input with its label, and a Copy button beside it. */
export function SecretField({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[13px] text-soft">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="h-11 w-full min-w-0 rounded-[10px] border border-edge bg-ink px-3 font-mono text-[13px] text-text focus:border-wire focus:outline-none"
        />
        <CopyButton text={value} />
      </div>
    </div>
  );
}

/** The panel a one-time secret sits in: a lime edge so it reads as new, and a line on why it matters. */
export function RevealPanel({ title, note, onDone, children }: { title: string; note: string; onDone: () => void; children: ReactNode }) {
  return (
    <div role="status" className="flex flex-col gap-4 rounded-2xl border border-spark/40 bg-spark/[0.04] p-5 sm:p-6">
      <div className="flex flex-col gap-1">
        <p className="font-medium text-text">{title}</p>
        <p className="text-[13px] text-soft">{note}</p>
      </div>
      {children}
      <Button variant="ghost" className="-ml-3 self-start px-3" onClick={onDone}>
        Done, hide it
      </Button>
    </div>
  );
}

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

export const ROLE_CAN: Record<Role, string> = {
  owner: "Made this workspace and manages who is in it.",
  editor: "Can change workflows and start runs.",
  viewer: "Can see workflows and runs, but not change or run them.",
};

export function day(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "in 6 days", "in 3 hours", "soon". */
export function timeUntil(ms: number) {
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 60) return "soon";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return `in ${d} ${d === 1 ? "day" : "days"}`;
}
