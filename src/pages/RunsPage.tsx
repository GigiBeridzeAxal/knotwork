import { useEffect } from "react";
import { LIMITS } from "../../shared/limits";
import { Card, duration, PageTitle, StatusBadge, timeAgo } from "../components/ui";
import { Link } from "../router";
import { useWorkspace } from "../workspace";

export function RunsPage() {
  // The newest 100 runs, loaded once for the whole app (the home page and the sidebar use them too).
  const { runs, error: loadError, refresh } = useWorkspace();
  const error = runs ? "" : loadError;

  useEffect(() => {
    // Every 15 s while the tab is visible; each request counts toward the free plan's daily requests.
    const timer = setInterval(() => document.visibilityState === "visible" && refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <PageTitle>Runs</PageTitle>
        <p className="text-soft">The latest 100 runs, newest first. Runs are kept for {LIMITS.runHistoryDays} days.</p>
      </div>
      {error && <p className="text-fail">{error}</p>}
      {runs && runs.length === 0 && <Card className="dots p-10 text-center text-soft">No runs yet. Run a workflow to see it here.</Card>}
      {runs && runs.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-line font-mono text-[11px] tracking-[0.12em] text-muted uppercase">
              <tr>
                <th className="px-5 py-3 font-normal">Workflow</th>
                <th className="px-5 py-3 font-normal">Status</th>
                <th className="px-5 py-3 font-normal">Trigger</th>
                <th className="px-5 py-3 font-normal">Started</th>
                <th className="px-5 py-3 font-normal">Took</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-ink/50">
                  <td className="px-5 py-3">
                    <Link href={`/runs/${r.id}`} className="font-medium hover:text-wire">
                      {r.workflowName}
                    </Link>
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={r.status} error={r.error} />
                  </td>
                  <td className="px-5 py-3 text-soft capitalize">{r.triggerType}</td>
                  <td className="px-5 py-3 text-soft">{timeAgo(r.createdAt)}</td>
                  <td className="px-5 py-3 font-mono text-xs text-muted">{r.finishedAt ? duration(r.finishedAt - r.createdAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
