import { type ReactNode, useEffect, useMemo, useState } from "react";
import { newStep } from "../../shared/examples";
import { LIMITS } from "../../shared/limits";
import type { Run, Step, StepTestResult, StepType, Workflow, WorkflowInput, WorkflowVersion, WorkflowVersionDetail } from "../../shared/schema";
import { allIds, countSteps, getList, getStep, insertStep, issueStep, moveStep, type Path, pathKey, refsFor, removeStep, replaceStep } from "../../shared/tree";
import { api, type Issue } from "../api";
import { CloseIcon } from "../components/icons";
import { Button, cn, Eyebrow, Field, StatusBadge, textareaClass, timeAgo } from "../components/ui";
import { StepEditor } from "../pages/StepEditor";
import { Link } from "../router";
import { Canvas, type Selection } from "./Canvas";
import { describeTrigger, typeLabel } from "./describe";
import { History, sampleText, TestPanel } from "./panels";
import { exportWorkflow } from "./transfer";

type WorkflowTab = "details" | "history" | "runs";
type StepTab = "settings" | "test";

function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string }[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-line px-3">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            "-mb-px flex h-11 items-center border-b-2 px-2 text-[13px] font-medium transition-colors",
            value === tab.id ? "border-text text-text" : "border-transparent text-muted hover:text-text",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The workflow as a canvas, with a panel beside it (under it, as a sheet, on a phone) for whatever is
 * selected: the trigger, a step, or the workflow itself. It edits the same draft as the step list.
 */
export function CanvasView({
  draft,
  saved,
  runs,
  issues,
  resetKey,
  update,
  secretNames = [],
  triggerEditor,
  sampleInput,
  onRestore,
  onDelete,
}: {
  draft: WorkflowInput;
  /** The workspace's secrets, offered next to the other things a template can use. */
  secretNames?: string[];
  saved: Workflow | null;
  runs: Run[];
  issues: Issue[];
  /** Changes when the server's copy replaces the draft, so fields with their own text start over. */
  resetKey: number;
  update: (patch: Partial<WorkflowInput>) => void;
  /** The trigger's form (the same one the step list shows). */
  triggerEditor: ReactNode;
  /** What `trigger.body` starts as in the test data. */
  sampleInput: unknown;
  onRestore: (workflow: WorkflowInput, version: number) => void;
  onDelete: () => void;
}) {
  const [selected, setSelected] = useState<Selection>(null);
  /** On a phone the workflow's own panel stays out of the way until it's asked for. */
  const [sheet, setSheet] = useState(false);
  const [workflowTab, setWorkflowTab] = useState<WorkflowTab>("details");
  const [stepTab, setStepTab] = useState<StepTab>("settings");
  const [sample, setSample] = useState(() => sampleText({ trigger: { body: sampleInput ?? {} }, steps: {} }));
  const [results, setResults] = useState<Record<string, StepTestResult>>({});
  const [preview, setPreview] = useState<WorkflowVersionDetail | null>(null);
  const [notice, setNotice] = useState("");

  const steps = draft.steps;
  const setSteps = (next: Step[]) => update({ steps: next });
  const step = selected && selected !== "trigger" ? getStep(steps, selected) : null;
  const stepPath = step ? (selected as Path) : null;
  // A selection can outlive its step (the draft was replaced by a restore or the server's copy).
  useEffect(() => {
    if (selected && selected !== "trigger" && !step) setSelected(null);
  }, [selected, step]);

  const stepIssues = useMemo(() => {
    const byStep = new Map<string, string[]>();
    for (const issue of issues) {
      const where = issueStep(issue.path);
      if (!where) continue;
      const key = pathKey(where.path);
      byStep.set(key, [...(byStep.get(key) ?? []), `${where.field || "step"}: ${issue.message}`]);
    }
    return byStep;
  }, [issues]);
  const broken = useMemo(() => new Set(stepIssues.keys()), [stepIssues]);
  // After a save that found problems, open the first step that has one.
  useEffect(() => {
    const first = issues.map((i) => issueStep(i.path)).find(Boolean);
    if (first) select(first.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issues]);

  function select(next: Selection) {
    setSelected(next);
    setSheet(false);
    setNotice("");
    if (next && preview) setPreview(null);
  }

  function insert(slot: Path, type: StepType) {
    setSteps(insertStep(steps, slot, newStep(type, allIds(steps))));
    setStepTab("settings");
    select(slot);
  }

  function move(from: Path, slot: Path) {
    const moved = moveStep(steps, from, slot);
    if (!moved) return;
    setSteps(moved.steps);
    select(moved.path);
  }

  function nudge(dir: -1 | 1) {
    if (!stepPath) return;
    const index = stepPath[stepPath.length - 1] as number;
    move(stepPath, [...stepPath.slice(0, -1), dir === -1 ? index - 1 : index + 2]);
  }

  async function view(version: WorkflowVersion) {
    if (!saved) return;
    setNotice("");
    try {
      setPreview(await api.version(saved.id, version.version));
      setSelected(null);
      setSheet(false);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  const siblings = stepPath ? (getList(steps, stepPath.slice(0, -1))?.length ?? 0) : 0;
  const index = stepPath ? (stepPath[stepPath.length - 1] as number) : 0;
  const shown = preview?.workflow ?? draft;
  const panelOpen = selected !== null || sheet;
  const full = countSteps(steps) >= LIMITS.stepsPerWorkflow;

  return (
    <div className="relative flex h-[calc(100dvh-15rem)] min-h-[440px] overflow-hidden rounded-2xl border border-line bg-ink lg:h-[calc(100dvh-13.5rem)] lg:min-h-[520px]">
      <div className="relative min-w-0 flex-1">
        <Canvas
          className="size-full"
          trigger={shown.trigger}
          steps={shown.steps}
          enabled={shown.enabled}
          selected={preview ? null : selected}
          onSelect={select}
          errors={preview ? undefined : broken}
          readOnly={preview !== null}
          full={full}
          onInsert={insert}
          onMove={move}
          topInset={preview ? 56 : 0}
          fitKey={`${saved?.id ?? "new"}-${preview?.version ?? "draft"}-${resetKey}`}
        />

        {preview ? (
          <div
            role="status"
            className="absolute inset-x-3 top-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-graphite py-2 pr-2 pl-4 sm:right-auto sm:left-1/2 sm:w-max sm:max-w-[calc(100%-1.5rem)] sm:-translate-x-1/2"
          >
            <p className="text-[13px] text-soft">
              <span className="font-medium text-text">Version {preview.version}</span>, saved {timeAgo(preview.savedAt)}
            </p>
            <div className="ml-auto flex gap-1">
              <Button variant="ghost" className="h-9" onClick={() => setPreview(null)}>
                Back to now
              </Button>
              <Button
                className="h-9"
                onClick={() => {
                  onRestore(preview.workflow, preview.version);
                  setNotice(`Version ${preview.version} is loaded. Save to keep it.`);
                  setPreview(null);
                }}
              >
                Restore this version
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setSelected(null);
              setSheet(true);
            }}
            className="absolute top-3 right-3 flex h-10 items-center rounded-xl border border-line bg-graphite px-3 text-[13px] font-medium text-soft hover:text-text lg:hidden"
          >
            Details
          </button>
        )}
        {full && !preview && (
          <p className="absolute right-3 bottom-3 max-w-[60%] rounded-xl border border-line bg-graphite px-3 py-2 text-xs text-muted">
            {LIMITS.stepsPerWorkflow} steps is the most a workflow can have.
          </p>
        )}
      </div>

      <aside
        aria-label={step ? `Step: ${step.name}` : selected === "trigger" ? "Trigger" : "Workflow"}
        className={cn(
          "z-40 flex-col border-line bg-deep lg:static lg:flex lg:w-[400px] lg:shrink-0 lg:border-l",
          "fixed inset-x-0 bottom-0 max-h-[64dvh] rounded-t-2xl border-t shadow-[0_-24px_48px_-12px_rgb(0_0_0/0.7)] lg:max-h-none lg:rounded-none lg:border-t-0 lg:shadow-none",
          panelOpen ? "flex" : "hidden",
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-3 pr-2 pl-5">
          <div className="flex min-w-0 flex-1 flex-col">
            <Eyebrow>{step ? typeLabel(step.type) : selected === "trigger" ? "Trigger" : "Workflow"}</Eyebrow>
            <span className="truncate text-sm font-medium">
              {step ? step.name : selected === "trigger" ? describeTrigger(draft.trigger).label : draft.name}
            </span>
          </div>
          <button
            type="button"
            aria-label="Close panel"
            onClick={() => {
              setSelected(null);
              setSheet(false);
            }}
            className={cn("grid size-10 place-items-center rounded-full text-muted hover:bg-graphite hover:text-text", !selected && "lg:hidden")}
          >
            <CloseIcon className="size-[18px]" />
          </button>
        </div>

        {step && stepPath ? (
          <>
            <Tabs
              label="Step"
              value={stepTab}
              onChange={setStepTab}
              tabs={[
                { id: "settings", label: "Settings" },
                { id: "test", label: "Test" },
              ]}
            />
            {/* The step's form lays itself out for a wide page; in this narrow panel its rows stack. */}
            <div className="sheet-scroll min-h-0 flex-1 overflow-y-auto p-5 [&_.grid]:grid-cols-1!">
              {stepTab === "settings" ? (
                <StepEditor
                  key={`${resetKey}-${pathKey(stepPath)}-${step.type}`}
                  embedded
                  step={step}
                  index={index}
                  total={siblings}
                  refs={[...refsFor(steps, stepPath), ...secretNames.map((name) => `secrets.${name}`)]}
                  errors={stepIssues.get(pathKey(stepPath)) ?? []}
                  open
                  onToggle={() => {}}
                  onChange={(next) => setSteps(replaceStep(steps, stepPath, next))}
                  onMove={nudge}
                  onRemove={() => {}}
                />
              ) : (
                <TestPanel
                  key={step.id}
                  step={step}
                  workflowId={saved?.id ?? null}
                  workflowName={draft.name}
                  sample={sample}
                  onSample={setSample}
                  result={results[step.id] ?? null}
                  onResult={(result) =>
                    setResults((all) => {
                      const { [step.id]: _, ...rest } = all;
                      return result ? { ...rest, [step.id]: result } : rest;
                    })
                  }
                />
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1 border-t border-line p-3">
              <Button variant="ghost" className="px-3" disabled={index === 0} onClick={() => nudge(-1)}>
                Move up
              </Button>
              <Button variant="ghost" className="px-3" disabled={index >= siblings - 1} onClick={() => nudge(1)}>
                Move down
              </Button>
              <Button
                variant="danger"
                className="ml-auto"
                onClick={() => {
                  setSteps(removeStep(steps, stepPath));
                  setSelected(null);
                }}
              >
                Remove step
              </Button>
            </div>
          </>
        ) : selected === "trigger" ? (
          <div className="sheet-scroll min-h-0 flex-1 overflow-y-auto border-t border-line p-5">{triggerEditor}</div>
        ) : (
          <>
            <Tabs
              label="Workflow"
              value={workflowTab}
              onChange={setWorkflowTab}
              tabs={[
                { id: "details", label: "Details" },
                { id: "history", label: "History" },
                { id: "runs", label: "Runs" },
              ]}
            />
            <div className="sheet-scroll min-h-0 flex-1 overflow-y-auto p-5">
              {notice && (
                <p role="status" className="mb-5 rounded-[10px] bg-graphite px-3 py-2.5 text-[13px] text-soft">
                  {notice}
                </p>
              )}
              {workflowTab === "details" && (
                <div className="flex flex-col gap-5">
                  <Field label="Description" htmlFor="wf-desc">
                    <textarea
                      id="wf-desc"
                      rows={4}
                      className={cn(textareaClass, "font-sans")}
                      value={draft.description}
                      onChange={(e) => update({ description: e.target.value })}
                    />
                  </Field>
                  <label className="flex min-h-11 items-center gap-3 text-sm">
                    <input type="checkbox" className="size-4 accent-spark" checked={draft.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
                    On (schedules and webhooks start runs)
                  </label>
                  <div className="flex flex-col gap-3 border-t border-line pt-5">
                    <Button onClick={() => exportWorkflow(draft)}>Export as a file</Button>
                    <p className="text-xs leading-relaxed text-muted">
                      A small JSON file with the trigger and steps, to keep or to import into another workspace. It holds no webhook URL and no run history. Anything typed into a step, such as an API key in a header, is in the file, so check it before sharing.
                    </p>
                  </div>
                  {saved && (
                    <div className="border-t border-line pt-5">
                      <Button variant="danger" onClick={onDelete}>
                        Delete workflow
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {workflowTab === "history" && (
                <History workflowId={saved?.id ?? null} current={saved?.version ?? 0} viewing={preview?.version ?? null} onView={view} />
              )}
              {workflowTab === "runs" && (
                <div className="flex flex-col gap-3">
                  {!saved || runs.length === 0 ? (
                    <p className="text-sm text-muted">No runs yet. Press Run now to start one.</p>
                  ) : (
                    <ul className="-mx-2 flex flex-col">
                      {runs.slice(0, 12).map((r) => (
                        <li key={r.id}>
                          <Link href={`/runs/${r.id}`} className="flex min-h-11 items-center justify-between gap-2 rounded-[10px] px-2 hover:bg-graphite">
                            <StatusBadge status={r.status} error={r.error} />
                            <span className="text-sm text-muted">{timeAgo(r.createdAt)}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
