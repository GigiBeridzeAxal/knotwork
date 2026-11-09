import { useEffect, useMemo, useRef, useState } from "react";
import { type Run, type SecretInfo, signatureProviders, type Step, type Trigger, walkSteps, type Workflow, type WorkflowInput } from "../../shared/schema";
import { validateCron } from "../../shared/cron";
import { api, ApiError, type Issue } from "../api";
import { Button, Card, cn, Eyebrow, Field, inputClass, StatusBadge, textareaClass, timeAgo } from "../components/ui";
import { BLANK } from "../../shared/examples";
import { Link, navigate } from "../router";
import { useFindElsewhere } from "../session";
import { StepList } from "./StepList";
import { CanvasView } from "../canvas/CanvasView";
import { stashedImport } from "../canvas/transfer";
import { findTemplate } from "../../shared/templates";

const CRON_PRESETS = [
  { label: "Every 5 minutes", cron: "*/5 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 9:00 UTC", cron: "0 9 * * *" },
  { label: "Mondays at 8:00 UTC", cron: "0 8 * * 1" },
];

type View = "canvas" | "list";
const VIEW_KEY = "knotwork.editorView";

/** A new workflow starts blank, from a template (`?template=<id>`) or from an imported file (`?import`). */
function startingPoint(): { draft: WorkflowInput; input?: unknown } {
  const query = new URLSearchParams(location.search);
  const template = findTemplate(query.get("template") ?? "");
  if (template) return { draft: structuredClone(template.workflow), input: template.sampleInput };
  const imported = query.has("import") ? stashedImport() : null;
  return { draft: imported ?? structuredClone(BLANK) };
}

const DEFAULT_INPUT = { amount: 120, id: "order_1" };

function toInput(wf: Workflow): WorkflowInput {
  return { name: wf.name, description: wf.description, enabled: wf.enabled, trigger: wf.trigger, steps: wf.steps };
}

export function EditorPage({ id }: { id: string | null }) {
  const [saved, setSaved] = useState<Workflow | null>(null);
  const [start] = useState(() => (id ? null : startingPoint()));
  const [draft, setDraft] = useState<WorkflowInput | null>(start?.draft ?? null);
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "canvas";
    } catch {
      return "canvas";
    }
  });
  const [issues, setIssues] = useState<Issue[]>([]);
  const [message, setMessage] = useState("");
  /** Someone saved this workflow elsewhere (another tab or device) after it was opened here. */
  const [conflict, setConflict] = useState<Workflow | null>(null);
  const saveRef = useRef<(() => Promise<Workflow | null>) | null>(null);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [showRun, setShowRun] = useState(false);
  const [runInput, setRunInput] = useState(() => JSON.stringify(start?.input ?? DEFAULT_INPUT, null, 2));
  // Remounts the step editors after a save, so their local text matches what the server stored.
  const [version, setVersion] = useState(0);
  const findElsewhere = useFindElsewhere();
  /** The workspace's secret names, to offer as {{ secrets.NAME }} and as webhook signing secrets. */
  const [secrets, setSecrets] = useState<SecretInfo[]>([]);
  useEffect(() => {
    let stale = false;
    let loadedAt = 0;
    const load = () => {
      // Coming back to the tab asks again, but not more than twice a minute.
      if (Date.now() - loadedAt < 30_000) return;
      loadedAt = Date.now();
      api.secrets().then((list) => !stale && setSecrets(list), () => {});
    };
    load();
    // Settings opens in another tab from here; coming back picks up a secret added there.
    window.addEventListener("focus", load);
    return () => {
      stale = true;
      window.removeEventListener("focus", load);
    };
  }, []);

  /** True once the user has changed the draft: a late or repeated load must not replace their edit. */
  const touched = useRef(false);

  useEffect(() => {
    if (!id) return;
    let stale = false;
    api.workflow(id).then(
      (wf) => {
        if (stale) return;
        setSaved(wf);
        if (!touched.current) setDraft(toInput(wf));
      },
      async (e) => {
        if (stale) return;
        if (e instanceof ApiError && e.status === 404 && (await findElsewhere("workflow", id))) return;
        setMessage(e.message);
      },
    );
    api.runs(id).then((r) => !stale && setRuns(r), () => {});
    return () => {
      stale = true;
    };
  }, [id, findElsewhere]);

  const dirty = useMemo(
    () => !saved || JSON.stringify(toInput(saved)) !== JSON.stringify(draft),
    [saved, draft],
  );

  if (!draft) return message ? <p className="text-fail">{message}</p> : null;

  const update = (patch: Partial<WorkflowInput>) => {
    touched.current = true;
    setDraft({ ...draft, ...patch });
  };
  const setSteps = (steps: Step[]) => update({ steps });

  const fieldError = (name: string) => issues.find((x) => x.path[0] === name)?.message;
  const cronError = draft.trigger.type === "schedule" ? validateCron(draft.trigger.cron) : null;

  async function save(): Promise<Workflow | null> {
    if (conflict) return null;
    setBusy(true);
    setMessage("");
    setIssues([]);
    try {
      const wf = saved ? await api.updateWorkflow(saved.id, draft!, saved.version) : await api.createWorkflow(draft!);
      setSaved(wf);
      setDraft(toInput(wf));
      touched.current = false;
      setVersion((v) => v + 1);
      if (!saved) navigate(`/workflows/${wf.id}`, { replace: true });
      setMessage("Saved");
      return wf;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data.current) {
        setConflict(e.data.current as Workflow);
        return null;
      }
      if (e instanceof ApiError) setIssues(e.issues ?? []);
      setMessage((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  saveRef.current = save;

  async function run() {
    let input: unknown = {};
    if (runInput.trim()) {
      try {
        input = JSON.parse(runInput);
      } catch {
        setMessage("The test input isn't valid JSON");
        return;
      }
    }
    const wf = dirty ? await save() : saved;
    if (!wf) return;
    setBusy(true);
    try {
      const { runId } = await api.runWorkflow(wf.id, input);
      navigate(`/runs/${runId}`);
    } catch (e) {
      setMessage((e as Error).message);
      setBusy(false);
    }
  }

  async function remove() {
    if (!saved || !confirm(`Delete "${saved.name}" and all its runs?`)) return;
    await api.deleteWorkflow(saved.id);
    navigate("/workflows");
  }

  const takenIds: string[] = [];
  walkSteps(draft.steps, (step) => takenIds.push(step.id));
  // Problems with the step list as a whole (too many steps), not with one step in it.
  const listError = issues.find((x) => x.path[0] === "steps" && x.path.length === 1)?.message;

  const hookUrl = saved ? `${location.origin}/hooks/${saved.hookKey}` : "";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-2">
          <Link href="/workflows" className="text-sm text-soft hover:text-text">
            ← Workflows
          </Link>
          <label htmlFor="wf-name" className="sr-only">
            Workflow name
          </label>
          <input
            id="wf-name"
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
            className="w-full rounded-[10px] border border-transparent bg-transparent px-0 font-display text-3xl font-bold tracking-tight hover:border-line focus:border-wire focus:px-2 focus:outline-none sm:text-4xl"
          />
          {fieldError("name") && <p className="text-[13px] text-fail">{fieldError("name")}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {message && (
            <span role="status" className={cn("text-sm max-sm:order-last max-sm:basis-full", message === "Saved" ? "text-soft" : "text-fail")}>
              {message}
            </span>
          )}
          <div role="group" aria-label="View" className="flex h-11 items-center gap-1 rounded-[10px] border border-line p-1">
            {(["canvas", "list"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => {
                  setView(v);
                  try {
                    localStorage.setItem(VIEW_KEY, v);
                  } catch {
                    // Storage blocked: the choice lasts until the page is reloaded.
                  }
                }}
                className={cn(
                  "h-full rounded-md px-3 text-[13px] font-medium capitalize transition-colors",
                  view === v ? "bg-raised text-text" : "text-muted hover:text-text",
                )}
              >
                {v}
              </button>
            ))}
          </div>
          <Button onClick={save} disabled={busy || !dirty}>
            {saved ? (dirty ? "Save" : "Saved") : "Create"}
          </Button>
          <Button variant="primary" onClick={() => setShowRun((v) => !v)} disabled={busy} aria-expanded={showRun}>
            Run now
          </Button>
        </div>
      </div>

      {conflict && (
        <div role="alert" className="flex flex-col gap-4 rounded-2xl border border-retry/40 bg-retry/5 p-5 sm:flex-row sm:items-center">
          <p className="text-sm text-soft">
            <span className="font-medium text-text">This workflow was saved somewhere else</span> after you opened it here
            {conflict.updatedAt ? ` (${timeAgo(conflict.updatedAt)})` : ""}. Keep your version, or load theirs and lose your changes.
          </p>
          <div className="flex shrink-0 gap-2 sm:ml-auto">
            <Button
              variant="ghost"
              onClick={() => {
                setSaved(conflict);
                setDraft(toInput(conflict));
                touched.current = false;
                setVersion((v) => v + 1);
                setConflict(null);
                setMessage("");
              }}
            >
              Load theirs
            </Button>
            <Button
              onClick={() => {
                // Save on top of the newer version: take its version number, keep this draft.
                setSaved(conflict);
                setConflict(null);
                setTimeout(() => saveRef.current?.(), 0);
              }}
            >
              Keep mine
            </Button>
          </div>
        </div>
      )}

      {showRun && (
        <Card className="flex flex-col gap-4 p-5">
          <Field label="Test input (becomes trigger.body)" htmlFor="run-input">
            <textarea id="run-input" rows={5} spellCheck={false} className={textareaClass} value={runInput} onChange={(e) => setRunInput(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setShowRun(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={run} disabled={busy}>
              {dirty ? "Save and run" : "Run"}
            </Button>
          </div>
        </Card>
      )}

      {view === "canvas" && (
        <CanvasView
          draft={draft}
          saved={saved}
          runs={runs}
          issues={issues}
          resetKey={version}
          update={update}
          secretNames={secrets.map((x) => x.name)}
          sampleInput={(() => {
            try {
              return JSON.parse(runInput);
            } catch {
              return {};
            }
          })()}
          triggerEditor={
            <TriggerCard bare trigger={draft.trigger} onChange={(trigger) => update({ trigger })} hookUrl={hookUrl} cronError={cronError} secrets={secrets} />
          }
          onRestore={(workflow) => {
            touched.current = true;
            setDraft(workflow);
            setIssues([]);
            setVersion((v) => v + 1);
          }}
          onDelete={remove}
        />
      )}

      {view === "list" && (
      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        {/* min-w-0: a grid column is otherwise as wide as its longest unbroken line (the webhook URL). */}
        <div className="flex min-w-0 flex-col">
          <TriggerCard
            trigger={draft.trigger}
            onChange={(trigger) => update({ trigger })}
            hookUrl={hookUrl}
            cronError={cronError}
            secrets={secrets}
          />

          <StepList
            steps={draft.steps}
            onChange={setSteps}
            issues={issues}
            refs={["trigger.body"]}
            tailRefs={["run.id", "workflow.name", ...secrets.map((x) => `secrets.${x.name}`)]}
            takenIds={takenIds}
            rev={version}
          />
          {listError && <p className="mt-3 text-[13px] text-fail">{listError}</p>}
        </div>

        <aside className="flex flex-col gap-6">
          <Card className="flex flex-col gap-4 p-5">
            <Field label="Description" htmlFor="wf-desc">
              <textarea
                id="wf-desc"
                rows={3}
                className={cn(textareaClass, "font-sans")}
                value={draft.description}
                onChange={(e) => update({ description: e.target.value })}
              />
            </Field>
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" className="size-4 accent-spark" checked={draft.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
              On (schedules and webhooks start runs)
            </label>
            {saved && (
              <Button variant="danger" onClick={remove}>
                Delete workflow
              </Button>
            )}
          </Card>

          {saved && (
            <Card className="flex flex-col gap-3 p-5">
              <Eyebrow>Recent runs</Eyebrow>
              {runs.length === 0 && <p className="text-sm text-muted">No runs yet.</p>}
              <ul className="flex flex-col">
                {runs.slice(0, 8).map((r) => (
                  <li key={r.id}>
                    <Link href={`/runs/${r.id}`} className="flex min-h-11 items-center justify-between gap-2 rounded-[10px] px-2 hover:bg-ink">
                      <StatusBadge status={r.status} error={r.error} />
                      <span className="text-sm text-muted">{timeAgo(r.createdAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </aside>
      </div>
      )}
    </div>
  );
}

function TriggerCard({
  trigger,
  onChange,
  hookUrl,
  cronError,
  secrets,
  bare = false,
}: {
  /** Without the card around it, for the canvas's side panel. */
  bare?: boolean;
  trigger: Trigger;
  onChange: (t: Trigger) => void;
  hookUrl: string;
  cronError: string | null;
  secrets: SecretInfo[];
}) {
  const [copied, setCopied] = useState(false);
  const types: { type: Trigger["type"]; label: string; blurb: string }[] = [
    { type: "manual", label: "Manual", blurb: "Run it from here or the API" },
    { type: "webhook", label: "Webhook", blurb: "Any service can POST to a URL" },
    { type: "schedule", label: "Schedule", blurb: "Runs on a cron, in UTC" },
  ];
  return (
    <div className={cn("flex flex-col gap-4", !bare && "rounded-2xl border border-line bg-graphite p-4")}>
      {!bare && <span className="font-mono text-[11px] tracking-[0.12em] text-muted uppercase">Trigger</span>}
      <fieldset className={cn("grid gap-2", !bare && "sm:grid-cols-3")}>
        <legend className="sr-only">How this workflow starts</legend>
        {types.map((t) => (
          <label
            key={t.type}
            className={cn(
              "flex cursor-pointer flex-col gap-1 rounded-[10px] border p-3",
              trigger.type === t.type ? "border-spark bg-spark/8" : "border-line bg-ink hover:border-edge",
            )}
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <input
                type="radio"
                name="trigger"
                className="accent-spark"
                checked={trigger.type === t.type}
                onChange={() => onChange(t.type === "schedule" ? { type: "schedule", cron: "0 * * * *" } : { type: t.type } as Trigger)}
              />
              {t.label}
            </span>
            <span className="text-xs text-muted">{t.blurb}</span>
          </label>
        ))}
      </fieldset>

      {trigger.type === "schedule" && (
        <div className="flex flex-col gap-3">
          <Field label="Cron (minute hour day month weekday)" htmlFor="cron" error={cronError ?? undefined}>
            <input id="cron" className={cn(inputClass, "font-mono")} value={trigger.cron} onChange={(e) => onChange({ type: "schedule", cron: e.target.value })} />
          </Field>
          <div className="flex flex-wrap gap-2">
            {CRON_PRESETS.map((p) => (
              <button
                key={p.cron}
                type="button"
                onClick={() => onChange({ type: "schedule", cron: p.cron })}
                className="min-h-9 rounded-full border border-line px-3 text-xs text-soft hover:border-edge hover:text-text"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {trigger.type === "webhook" &&
        (hookUrl ? (
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-soft">Send a POST to this URL. Anyone with it can start a run, so keep it private.</span>
            <div className="flex gap-2">
              <code className="flex h-11 min-w-0 flex-1 items-center overflow-x-auto rounded-[10px] border border-edge bg-ink px-3 font-mono text-[13px] whitespace-nowrap">
                {hookUrl}
              </code>
              <Button
                onClick={() => {
                  navigator.clipboard.writeText(hookUrl).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-muted">Save the workflow to get its webhook URL.</p>
        ))}

      {trigger.type === "webhook" && <SignatureCheck trigger={trigger} onChange={onChange} secrets={secrets} />}
    </div>
  );
}

const PROVIDER = {
  github: {
    label: "GitHub",
    where: "the Secret field of the webhook in the repository's settings",
    setup: "In the repository, open Settings, then Webhooks, then Add webhook. Payload URL: the URL above. Content type: application/json. Secret: the same value you saved here.",
    trace: "the webhook's Recent Deliveries on GitHub",
  },
  stripe: {
    label: "Stripe",
    where: "the signing secret (whsec_…, the whole text) of the endpoint in Stripe's dashboard",
    setup: "In Stripe, open Developers, then Webhooks, and add an endpoint with the URL above. Copy its signing secret and save it here.",
    trace: "the event's delivery attempts in Stripe",
  },
} as const;

/** Lets a webhook refuse calls that weren't signed by GitHub or Stripe with a secret kept in the workspace. */
function SignatureCheck({
  trigger,
  onChange,
  secrets,
}: {
  trigger: Extract<Trigger, { type: "webhook" }>;
  onChange: (t: Trigger) => void;
  secrets: SecretInfo[];
}) {
  const verify = trigger.verify;
  // A secret the workflow names that has since been deleted still shows, so it isn't silently swapped.
  const names = [...new Set([...secrets.map((x) => x.name), ...(verify ? [verify.secret] : [])])];
  const missing = verify && !secrets.some((x) => x.name === verify.secret);
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Check the sender's signature" htmlFor="verify-provider">
          <select
            id="verify-provider"
            className={inputClass}
            value={verify?.provider ?? ""}
            onChange={(e) => {
              const provider = signatureProviders.find((p) => p === e.target.value);
              onChange(provider ? { type: "webhook", verify: { provider, secret: verify?.secret ?? names[0] ?? "" } } : { type: "webhook" });
            }}
          >
            <option value="">Off: anyone with the URL</option>
            {signatureProviders.map((p) => (
              <option key={p} value={p}>
                {PROVIDER[p].label}
              </option>
            ))}
          </select>
        </Field>
        {verify && (
          <Field label="Signing secret" htmlFor="verify-secret" error={!missing ? undefined : verify.secret ? `${verify.secret} isn't in this workspace's secrets` : "Add the signing secret in Settings first"}>
            <select
              id="verify-secret"
              className={cn(inputClass, "font-mono")}
              value={verify.secret}
              onChange={(e) => onChange({ type: "webhook", verify: { ...verify, secret: e.target.value } })}
            >
              {names.length === 0 && <option value="">No secrets yet</option>}
              {names.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </Field>
        )}
      </div>
      {verify && (
        <p className="text-[13px] text-muted">
          Calls without a valid {PROVIDER[verify.provider].label} signature are refused and start no run. Save {PROVIDER[verify.provider].where} as a secret in{" "}
          <a href="/settings" target="_blank" rel="noreferrer" className="text-soft underline underline-offset-2 hover:text-text">
            Settings
          </a>{" "}
          (opens in a new tab, so nothing here is lost), then pick it here. {PROVIDER[verify.provider].setup} A refused call leaves no run
          here; {PROVIDER[verify.provider].trace} show the answer and why.
        </p>
      )}
    </div>
  );
}
