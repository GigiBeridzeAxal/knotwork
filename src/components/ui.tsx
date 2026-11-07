import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LogStatus, RunStatus } from "../../shared/schema";

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect x="0.5" y="0.5" width="63" height="63" rx="16" fill="#171B22" stroke="#2A303B" />
      <path d="M22 14V50" stroke="#E8EAED" strokeWidth="6" strokeLinecap="round" fill="none" />
      <path d="M22 32L43 48" stroke="#E8EAED" strokeWidth="6" strokeLinecap="round" fill="none" />
      <path d="M22 32L40 19" stroke="#FF7A45" strokeWidth="6" strokeLinecap="round" fill="none" />
      <circle cx="43" cy="17" r="6.5" fill="#FF7A45" />
    </svg>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-11 items-center justify-center gap-2 rounded-[10px] px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-spark font-semibold text-ink hover:bg-spark-hover",
        variant === "secondary" && "border border-edge text-text hover:border-muted hover:bg-graphite",
        variant === "ghost" && "text-soft hover:bg-graphite hover:text-text",
        variant === "danger" && "border border-fail/40 text-fail hover:bg-fail/10",
        className,
      )}
      {...rest}
    />
  );
}

const STATUS: Record<RunStatus | LogStatus, { label: string; color: string }> = {
  queued: { label: "Queued", color: "text-muted bg-muted/12" },
  running: { label: "Running", color: "text-wire bg-wire/12" },
  waiting: { label: "Waiting", color: "text-retry bg-retry/12" },
  retrying: { label: "Retrying", color: "text-retry bg-retry/12" },
  succeeded: { label: "Passed", color: "text-pass bg-pass/12" },
  ok: { label: "Passed", color: "text-pass bg-pass/12" },
  failed: { label: "Failed", color: "text-fail bg-fail/12" },
  stopped: { label: "Stopped by filter", color: "text-soft bg-soft/12" },
};

export function StatusBadge({ status }: { status: RunStatus | LogStatus }) {
  const s = STATUS[status];
  return (
    <span className={cn("inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap", s.color)}>
      <span className={cn("size-2 rounded-full bg-current", status === "running" && "animate-pulse")} />
      {s.label}
    </span>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-2xl border border-line bg-graphite", className)}>{children}</div>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="font-mono text-[11px] tracking-[0.12em] text-muted uppercase">{children}</div>;
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">{children}</h1>;
}

export const inputClass =
  "h-11 w-full rounded-[10px] border border-edge bg-ink px-3 text-sm text-text placeholder:text-muted focus:border-wire focus:outline-none";

export const textareaClass =
  "w-full rounded-[10px] border border-edge bg-ink px-3 py-2.5 font-mono text-[13px] leading-relaxed text-text placeholder:text-muted focus:border-wire focus:outline-none";

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-[13px] text-soft">
        {label}
      </label>
      {children}
      {error ? <p className="text-[13px] text-fail">{error}</p> : hint ? <p className="text-[13px] text-muted">{hint}</p> : null}
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-[10px] border border-line bg-ink p-3 font-mono text-[12.5px] leading-relaxed text-soft">
      {value === undefined ? "—" : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
