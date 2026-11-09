import { useRef, useState } from "react";
import { canEdit } from "../../shared/schema";
import { useSession } from "../session";
import { TEMPLATE_CATEGORIES, type Template, type TemplateCategory, TEMPLATES } from "../../shared/templates";
import { describeTrigger, Glyph } from "../canvas/describe";
import { parseImport, stashImport } from "../canvas/transfer";
import { ArrowIcon } from "../components/icons";
import { Button, cn, Eyebrow, PageTitle } from "../components/ui";
import { Link, navigate } from "../router";

/** Opens a file exported from Knotwork in the editor, unsaved, so it can be looked over first. */
export function ImportButton({ onError, className }: { onError: (message: string) => void; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        tabIndex={-1}
        aria-label="Workflow file to import"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          if (file.size > 200_000) return onError("That file is too large to be a Knotwork workflow.");
          const result = parseImport(await file.text());
          if (!result.ok) return onError(result.error);
          onError("");
          stashImport(result.workflow);
          navigate("/workflows/new?import=1");
        }}
      />
      <Button className={className} onClick={() => input.current?.click()}>
        Import a file
      </Button>
    </>
  );
}

/** A template's shape at a glance: its trigger and steps as the tiles the canvas draws them with. */
function Shape({ template }: { template: Template }) {
  const { trigger, steps } = template.workflow;
  return (
    <div className="flex items-center" aria-hidden="true">
      <span className="grid size-8 place-items-center rounded-lg border border-edge bg-deep text-text">
        <Glyph type={trigger.type} />
      </span>
      {steps.map((step) => (
        <span key={step.id} className="flex items-center">
          <span className="h-px w-3 bg-edge" />
          <span className="grid size-8 place-items-center rounded-lg border border-line bg-deep text-muted">
            <Glyph type={step.type} />
          </span>
        </span>
      ))}
    </div>
  );
}

export function TemplatesPage() {
  const [category, setCategory] = useState<TemplateCategory | "All">("All");
  const [error, setError] = useState("");
  // A viewer can browse templates but not make workflows from them.
  const editable = canEdit(useSession().workspace.role);
  const shown = TEMPLATES.filter((t) => category === "All" || t.category === category);

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <PageTitle>Templates</PageTitle>
          <p className="max-w-xl text-soft">
            {TEMPLATES.length} workflows that run as they are.{" "}
            {editable
              ? "Open one on the canvas, look it over, and it becomes yours when you press Create."
              : "You're a viewer in this workspace, so you can browse them; an editor can create from them."}
          </p>
        </div>
        {editable && <ImportButton onError={setError} />}
      </div>

      {error && (
        <p role="alert" className="text-fail">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-6">
        <div role="group" aria-label="Category" className="flex flex-wrap gap-2">
          {(["All", ...TEMPLATE_CATEGORIES] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
              className={cn(
                "h-9 rounded-full border px-4 text-[13px] font-medium transition-colors pointer-coarse:h-11",
                category === c ? "border-text bg-text text-ink" : "border-line text-soft hover:border-edge hover:text-text",
              )}
            >
              {c}
            </button>
          ))}
        </div>

        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((t) => (
            <li key={t.id}>
              <Link
                href={`/workflows/new?template=${t.id}`}
                className="group flex h-full flex-col gap-5 rounded-2xl border border-line bg-graphite p-5 transition-colors hover:border-edge"
              >
                <Shape template={t} />
                <div className="flex flex-col gap-1.5">
                  <Eyebrow>
                    {t.category} · {describeTrigger(t.workflow.trigger).label}
                  </Eyebrow>
                  <h2 className="font-medium">{t.title}</h2>
                  <p className="text-sm text-soft">{t.blurb}</p>
                </div>
                <span className="mt-auto inline-flex items-center gap-1 text-[13px] text-muted transition-colors group-hover:text-text">
                  Open on the canvas
                  <ArrowIcon className="size-4" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
