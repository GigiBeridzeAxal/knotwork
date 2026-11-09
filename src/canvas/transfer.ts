import { LIMITS } from "../../shared/limits";
import { workflowInput, type WorkflowInput } from "../../shared/schema";

/**
 * Export and import. A workflow leaves as a small JSON file and comes back through the same checks a
 * save goes through, so a file from anywhere can't put anything into the editor that typing couldn't.
 * The file holds the trigger and steps only: no ids, no webhook URL, no run history.
 */

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "workflow";

export function exportWorkflow(workflow: WorkflowInput) {
  const file = { knotwork: 1, exportedAt: new Date().toISOString(), workflow };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug(workflow.name)}.knotwork.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export type Imported = { ok: true; workflow: WorkflowInput } | { ok: false; error: string };

/** Reads an exported file's text. Accepts the export format, or a bare workflow object. */
export function parseImport(text: string): Imported {
  if (text.length > LIMITS.workflowBytes * 2) return { ok: false, error: `That file is too large. A workflow is at most ${LIMITS.workflowBytes / 1000} KB.` };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't JSON. Choose a file exported from Knotwork." };
  }
  const candidate = data && typeof data === "object" && "workflow" in data ? (data as { workflow: unknown }).workflow : data;
  const parsed = workflowInput.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` (${first.path.join(".")})` : "";
    return { ok: false, error: `That file isn't a Knotwork workflow: ${first?.message ?? "unknown format"}${where}.` };
  }
  return { ok: true, workflow: parsed.data };
}

// A workflow on its way into the editor (an imported file) waits here while the editor page opens.
const PENDING = "knotwork.import";

export function stashImport(workflow: WorkflowInput) {
  sessionStorage.setItem(PENDING, JSON.stringify(workflow));
}

export function stashedImport(): WorkflowInput | null {
  try {
    const parsed = parseImport(sessionStorage.getItem(PENDING) ?? "");
    return parsed.ok ? parsed.workflow : null;
  } catch {
    return null;
  }
}
