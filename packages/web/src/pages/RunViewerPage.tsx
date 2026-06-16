import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { AuditTrail } from "../components/AuditTrail";
import { ChainBadge } from "../components/ChainBadge";
import { RunTimeline } from "../components/RunTimeline";
import { ErrorNote, Loading, RelTime, StatusPill } from "../components/ui";
import { getRun, verifyAudit, type RunDetail } from "../lib/api";
import { actorLabel, formatDuration, isTerminalRunStatus } from "../lib/format";

/** Poll a live run every 2s; stop the moment it reaches a terminal status. */
export function runRefetchInterval(data: RunDetail | undefined): number | false {
  if (data && isTerminalRunStatus(data.run.status)) return false;
  return 2000;
}

export function RunViewerPage() {
  const params = useParams({ strict: false });
  const runId = params.runId ?? "";

  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: () => getRun(runId),
    refetchInterval: (query) => runRefetchInterval(query.state.data),
  });
  const verifyQuery = useQuery({
    queryKey: ["audit-verify"],
    queryFn: verifyAudit,
    refetchInterval: 5000,
  });

  if (runQuery.isPending) return <Loading what="run" />;
  if (runQuery.isError) return <ErrorNote error={runQuery.error} />;

  const { run, steps, approvals, auditEvents } = runQuery.data;

  return (
    <div>
      <header>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-ink">{run.flow}</h1>
          <span className="font-mono text-sm text-stone-400">v{run.version}</span>
          <StatusPill status={run.status} />
        </div>
        <p className="mt-1.5 text-xs text-stone-500">
          Triggered by <span className="font-medium text-ink">{actorLabel(run.triggered_by)}</span>
          {" · "}started <RelTime iso={run.started_at ?? run.created_at} />
          {" · "}duration{" "}
          <span className="font-mono">{formatDuration(run.started_at, run.finished_at)}</span>
        </p>
        <p className="mt-0.5 font-mono text-[10px] text-stone-400">{run.id}</p>
      </header>

      {run.status === "failed" && run.failure_reason && (
        <div className="mt-4 border-l-4 border-blocked bg-red-50 px-4 py-3" role="alert">
          <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-blocked">
            Run failed
          </p>
          <p className="mt-1 text-sm leading-snug text-blocked">{run.failure_reason}</p>
        </div>
      )}

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_400px]">
        <section aria-label="Step timeline">
          <h2 className="mb-4 text-[11px] font-medium uppercase tracking-[0.1em] text-stone-400">
            Flow steps
          </h2>
          <RunTimeline definition={run.definition} steps={steps} approvals={approvals} />
        </section>

        <aside aria-label="Audit trail">
          <h2 className="mb-4 text-[11px] font-medium uppercase tracking-[0.1em] text-stone-400">
            Audit trail
          </h2>
          <ChainBadge verify={verifyQuery.data} />
          <div className="mt-4">
            <AuditTrail events={auditEvents} />
          </div>
        </aside>
      </div>
    </div>
  );
}
