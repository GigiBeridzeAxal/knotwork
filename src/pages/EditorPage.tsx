import { useEffect, useMemo, useRef, useState } from "react";
import type { Run, Step, StepType, Trigger, Workflow, WorkflowInput } from "../../shared/schema";
import { validateCron } from "../../shared/cron";
import { api, ApiError, type Issue } from "../api";
import { Button, Card, cn, Eyebrow, Field, inputClass, StatusBadge, textareaClass, timeAgo } from "../components/ui";
import { BLANK, newStep, STEP_TYPES } from "../../shared/examples";
import { Link, navigate } from "../router";
import { StepEditor } from "./StepEditor";

const CRON_PRESETS = [
  { label: "Every 5 minutes", cron: "*/5 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 9:00 UTC", cron: "0 9 * * *" },
  { label: "Mondays at 8:00 UTC", cron: "0 8 * * 1" },
];

function toInput(wf: Workflow): WorkflowInput {
  return { name: wf.name, description: wf.description, enabled: wf.enabled, trigger: wf.trigger, steps: wf.steps };
}

export function EditorPage({ id }: { id: string | null }) {
  const [saved, setSaved] = useState<Workflow | null>(null);
  const [draft, setDraft] = useState<WorkflowInput | null>(id ? null : structuredClone(BLANK));
  const [openStep, setOpenStep] = useState<number | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [message, setMessage] = useState("");
  /** Someone saved this workflow elsewhere (another tab or device) after it was opened here. */
  const [conflict, setConflict] = useState<Workflow | null>(null);
  const saveRef = useRef<(() => Promise<Workflow | null>) | null>(null);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [showRun, setShowRun] = useState(false);
  const [runInput, setRunInput] = useState('{\n  "amount": 120,\n  "id": "order_1"\n}');
  // Remounts the step editors after a save, so their local text matches what the server stored.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!id) return;
    api.workflow(id).then(
      (wf) => {
        setSaved(wf);
        setDraft(toInput(wf));
      },
      (e) => setMessage(e.message),
    );
    api.runs(id).then(setRuns, () => {});
  }, [id]);

  const dirty = useMemo(
    () => !saved || JSON.stringify(toInput(saved)) !== JSON.stringify(draft),
    [saved, draft],
  );

  if (!draft) return message ? <p className="text-fail">{message}</p> : null;

  const update = (patch: Partial<WorkflowInput>) => setDraft({ ...draft, ...patch });
  const setSteps = (steps: Step[]) => update({ steps });

  const stepErrors = (i: number) =>
    issues.filter((x) => x.path[0] === "steps" && x.path[1] === i).map((x) => `${x.path.slice(2).join(".") || "step"}: ${x.message}`);
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
      setVersion((v) => v + 1);
      if (!saved) navigate(`/workflows/${wf.id}`, { replace: true });
      setMessage("Saved");
      return wf;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data.current) {
        setConflict(e.data.current as Workflow);
        return null;
      }
      if (e instanceof ApiError) {
        setIssues(e.issues ?? []);
        const firstStep = e.issues.find((x) => x.path[0] === "steps");
        if (firstStep && typeof firstStep.path[1] === "number") setOpenStep(firstStep.path[1]);
      }
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

  function addStep(type: StepType) {
    const step = newStep(type, draft!.steps.map((s) => s.id));
    setSteps([...draft!.steps, step]);
    setOpenStep(draft!.steps.length);
  }

  function move(i: number, dir: -1 | 1) {
    const steps = [...draft!.steps];
    [steps[i], steps[i + dir]] = [steps[i + dir], steps[i]];
    setSteps(steps);
    setVersion((v) => v + 1);
    if (openStep === i) setOpenStep(i + dir);
    else if (openStep === i + dir) setOpenStep(i);
  }

  const hookUrl = saved ? `${location.origin}/hooks/${saved.hookKey}` : "";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
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
            <span role="status" className={cn("text-sm", message === "Saved" ? "text-soft" : "text-fail")}>
              {message}
            </span>
          )}
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

      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col">
          <TriggerCard
            trigger={draft.trigger}
            onChange={(trigger) => update({ trigger })}
            hookUrl={hookUrl}
            cronError={cronError}
          />

          {draft.steps.map((step, i) => (
            <div key={`${version}-${i}-${step.type}`} className="flex flex-col">
              <Wire />
              <StepEditor
                step={step}
                index={i}
                total={draft.steps.length}
                refs={["trigger.body", ...draft.steps.slice(0, i).map((s) => `steps.${s.id}`), "run.id", "workflow.name"]}
                errors={stepErrors(i)}
                open={openStep === i}
                onToggle={() => setOpenStep(openStep === i ? null : i)}
                onChange={(s) => setSteps(draft.steps.map((x, j) => (j === i ? s : x)))}
                onMove={(dir) => move(i, dir)}
                onRemove={() => {
                  setSteps(draft.steps.filter((_, j) => j !== i));
                  setVersion((v) => v + 1);
                  setOpenStep(null);
                }}
              />
            </div>
          ))}

          <Wire dashed />
          <Card className="flex flex-col gap-3 border-dashed p-4">
            <Eyebrow>Add a step</Eyebrow>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {STEP_TYPES.map((t) => (
                <button
                  key={t.type}
                  type="button"
                  onClick={() => addStep(t.type)}
                  className="flex min-h-11 flex-col items-start gap-1 rounded-[10px] border border-line bg-ink p-3 text-left hover:border-edge"
                >
                  <span className="text-sm font-medium">{t.label}</span>
                  <span className="text-xs text-muted">{t.blurb}</span>
                </button>
              ))}
            </div>
          </Card>
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
                      <StatusBadge status={r.status} />
                      <span className="text-sm text-muted">{timeAgo(r.createdAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}

function Wire({ dashed = false }: { dashed?: boolean }) {
  return (
    <div className="flex h-8 justify-center" aria-hidden="true">
      <div className={cn("w-0.5", dashed ? "border-l-2 border-dashed border-edge" : "bg-wire")} />
    </div>
  );
}

function TriggerCard({
  trigger,
  onChange,
  hookUrl,
  cronError,
}: {
  trigger: Trigger;
  onChange: (t: Trigger) => void;
  hookUrl: string;
  cronError: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const types: { type: Trigger["type"]; label: string; blurb: string }[] = [
    { type: "manual", label: "Manual", blurb: "Run it from here or the API" },
    { type: "webhook", label: "Webhook", blurb: "Any service can POST to a URL" },
    { type: "schedule", label: "Schedule", blurb: "Runs on a cron, in UTC" },
  ];
  return (
    <Card className="flex flex-col gap-4 p-4">
      <span className="font-mono text-[11px] tracking-[0.12em] text-muted uppercase">Trigger</span>
      <fieldset className="grid gap-2 sm:grid-cols-3">
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
    </Card>
  );
}
