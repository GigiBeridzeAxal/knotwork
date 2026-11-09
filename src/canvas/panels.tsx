import { useEffect, useState } from "react";
import { LIMITS } from "../../shared/limits";
import type { Step, StepSample, StepTestResult, WorkflowVersion } from "../../shared/schema";
import { withoutChildren } from "../../shared/tree";
import { api } from "../api";
import { Button, cn, Field, Json, textareaClass, timeAgo } from "../components/ui";
import { describeTrigger } from "./describe";

/** The pieces of the canvas's side panel that talk to the server: testing one step, and history. */

const RESULT: Record<StepTestResult["status"], { label: string; color: string }> = {
  ok: { label: "Passed", color: "text-soft bg-soft/10" },
  failed: { label: "Failed", color: "text-fail bg-fail/12" },
  stopped: { label: "Would stop the run", color: "text-soft bg-soft/12" },
  waiting: { label: "Would wait", color: "text-retry bg-retry/12" },
};

function parseSample(text: string): StepSample | null {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const steps = (data as { steps?: unknown }).steps;
    return {
      trigger: (data as { trigger?: unknown }).trigger,
      steps: steps && typeof steps === "object" && !Array.isArray(steps) ? (steps as Record<string, unknown>) : {},
    };
  } catch {
    return null;
  }
}

export const sampleText = (sample: StepSample) => JSON.stringify({ trigger: sample.trigger ?? { body: {} }, steps: sample.steps }, null, 2);

/** Runs one step by itself against test data, without saving or starting a run. */
export function TestPanel({
  step,
  workflowId,
  workflowName,
  sample,
  onSample,
  result,
  onResult,
}: {
  step: Step;
  workflowId: string | null;
  workflowName: string;
  /** The test data as text; shared by every step, so testing down the workflow builds it up. */
  sample: string;
  onSample: (text: string) => void;
  result: StepTestResult | null;
  onResult: (result: StepTestResult | null) => void;
}) {
  const [busy, setBusy] = useState<"test" | "load" | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  async function test() {
    const parsed = parseSample(sample);
    if (!parsed) {
      setNote({ text: 'The test data isn\'t valid JSON. It should look like { "trigger": { "body": {} }, "steps": {} }.', bad: true });
      return;
    }
    setBusy("test");
    setNote(null);
    try {
      // A block is tested on its own: its condition or its list, not the steps inside it.
      const res = await api.testStep(withoutChildren(step), parsed, workflowName);
      onResult(res);
      if (res.status === "ok" && res.output !== undefined) {
        onSample(sampleText({ ...parsed, steps: { ...parsed.steps, [step.id]: res.output } }));
        setNote({ text: `Added to the test data as steps.${step.id}, so later steps can use it.`, bad: false });
      }
    } catch (e) {
      onResult(null);
      setNote({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(null);
    }
  }

  async function loadLastRun() {
    if (!workflowId) return;
    setBusy("load");
    setNote(null);
    try {
      const last = await api.sample(workflowId);
      if (!last) {
        setNote({ text: "This workflow has no finished run yet. Run it once, or type the data by hand.", bad: false });
      } else {
        onSample(sampleText({ trigger: last.trigger, steps: last.steps }));
        setNote({ text: `Loaded the run from ${timeAgo(last.createdAt)}${last.trimmed ? ", with its largest outputs left out" : ""}.`, bad: false });
      }
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Field
        label="Test data"
        htmlFor="test-data"
        hint={
          <>
            What <code className="font-mono text-soft">{"{{ trigger }}"}</code> and <code className="font-mono text-soft">{"{{ steps }}"}</code> hold
            for this test. Nothing is saved, and no run is started.
          </>
        }
      >
        <textarea id="test-data" rows={9} spellCheck={false} className={textareaClass} value={sample} onChange={(e) => onSample(e.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={test} disabled={busy !== null}>
          {busy === "test" ? "Testing…" : "Test this step"}
        </Button>
        {workflowId && (
          <Button variant="ghost" onClick={loadLastRun} disabled={busy !== null}>
            {busy === "load" ? "Loading…" : "Use the last run's data"}
          </Button>
        )}
      </div>
      {step.type === "http" && !result && !note && <p className="text-[13px] text-muted">Testing an HTTP step sends the real request.</p>}
      {note && (
        <p role="status" className={cn("text-[13px]", note.bad ? "text-fail" : "text-muted")}>
          {note.text}
        </p>
      )}
      {result && (
        <div className="flex flex-col gap-3" data-test-result={result.status}>
          <div className="flex items-center justify-between gap-3">
            <span className={cn("inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap", RESULT[result.status].color)}>
              <span className="size-2 rounded-full bg-current" />
              {RESULT[result.status].label}
            </span>
            <span className="font-mono text-[11px] text-muted tabular-nums">{result.durationMs} ms</span>
          </div>
          {result.message && <p className="font-mono text-[13px] leading-relaxed break-words text-soft">{result.message}</p>}
          {result.output !== undefined && <Json value={result.output} />}
        </div>
      )}
    </div>
  );
}

/** The workflow's saved versions, newest first. Choosing one shows it on the canvas before anything changes. */
export function History({
  workflowId,
  current,
  viewing,
  onView,
}: {
  workflowId: string | null;
  /** The version the editor has loaded; the list is fetched again when it changes (after a save). */
  current: number;
  viewing: number | null;
  onView: (version: WorkflowVersion) => void;
}) {
  const [versions, setVersions] = useState<WorkflowVersion[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!workflowId) return;
    let stale = false;
    api.versions(workflowId).then(
      (v) => !stale && setVersions(v),
      (e) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [workflowId, current]);

  if (!workflowId) return <p className="text-sm text-muted">Versions appear here once the workflow is saved. Every save adds one.</p>;
  if (error) return <p className="text-sm text-fail">{error}</p>;
  if (!versions) return <p className="text-sm text-muted" aria-busy="true">Loading versions…</p>;
  if (versions.length === 0) return <p className="text-sm text-muted">No versions yet. The next save adds the first one.</p>;

  return (
    <div className="flex flex-col gap-3">
      <ul className="-mx-2 flex flex-col">
        {versions.map((v) => (
          <li key={v.version}>
            <button
              type="button"
              onClick={() => onView(v)}
              aria-pressed={viewing === v.version}
              aria-label={`Version ${v.version}${v.version === current ? ", current" : ""}: ${v.name}, ${v.steps.length} ${v.steps.length === 1 ? "step" : "steps"}, from ${timeAgo(v.savedAt)}`}
              className={cn(
                "flex min-h-13 w-full items-center gap-3 rounded-[10px] px-2 text-left transition-colors hover:bg-graphite",
                viewing === v.version && "bg-graphite",
              )}
            >
              <span className="w-9 shrink-0 font-mono text-xs text-muted tabular-nums">v{v.version}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm text-text">{v.name}</span>
                <span className="truncate text-xs text-muted">
                  {describeTrigger(v.trigger).label} · {v.steps.length} {v.steps.length === 1 ? "step" : "steps"}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted">{v.version === current ? "Current" : timeAgo(v.savedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs leading-relaxed text-muted">Knotwork keeps the newest {LIMITS.versionsPerWorkflow} versions of a workflow. Pick one to look at it; nothing changes until you restore and save.</p>
    </div>
  );
}
