import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { EmptyNote, ErrorNote, Loading, PageTitle, RelTime, StatusPill } from "../components/ui";
import { listFlows, listRuns, triggerFlow } from "../lib/api";
import { formatDuration } from "../lib/format";

/** Recent runs + one-click flow triggers so the demo is clickable end to end. */
export function RunsListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runsQuery = useQuery({
    queryKey: ["runs"],
    queryFn: listRuns,
    refetchInterval: 5000,
  });
  const flowsQuery = useQuery({ queryKey: ["flows"], queryFn: listFlows });
  const trigger = useMutation({
    mutationFn: (name: string) => triggerFlow(name),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      void navigate({ to: "/runs/$runId", params: { runId: res.runId } });
    },
  });

  const publishedFlows = (flowsQuery.data?.flows ?? []).filter(
    (f) => f.latest_status === "published",
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle>Runs</PageTitle>
        <div className="flex flex-wrap gap-2">
          {publishedFlows.map((flow) => (
            <button
              key={flow.id}
              type="button"
              disabled={trigger.isPending}
              onClick={() => trigger.mutate(flow.name)}
              className="rounded border border-ink bg-white px-3 py-1.5 text-xs font-medium text-ink hover:bg-ink hover:text-white disabled:opacity-50"
            >
              Trigger {flow.name}
            </button>
          ))}
        </div>
      </div>
      {trigger.isError && (
        <div className="mt-3">
          <ErrorNote error={trigger.error} />
        </div>
      )}

      <div className="mt-6">
        {runsQuery.isPending ? (
          <Loading what="runs" />
        ) : runsQuery.isError ? (
          <ErrorNote error={runsQuery.error} />
        ) : runsQuery.data.runs.length === 0 ? (
          <EmptyNote>No runs yet — trigger a flow above.</EmptyNote>
        ) : (
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-[0.08em] text-stone-400">
                <th className="py-2 pr-4 font-medium">Flow</th>
                <th className="py-2 pr-4 font-medium">Version</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Started</th>
                <th className="py-2 font-medium">Duration</th>
              </tr>
            </thead>
            <tbody>
              {runsQuery.data.runs.map((run) => (
                <tr
                  key={run.id}
                  onClick={() => void navigate({ to: "/runs/$runId", params: { runId: run.id } })}
                  className="cursor-pointer border-b border-line hover:bg-white"
                >
                  <td className="py-2.5 pr-4 font-medium text-ink">{run.flow}</td>
                  <td className="py-2.5 pr-4 font-mono text-xs text-stone-500">v{run.version}</td>
                  <td className="py-2.5 pr-4">
                    <StatusPill status={run.status} />
                  </td>
                  <td className="py-2.5 pr-4 text-stone-600">
                    <RelTime iso={run.started_at ?? run.created_at} />
                  </td>
                  <td className="py-2.5 font-mono text-xs text-stone-600">
                    {formatDuration(run.started_at, run.finished_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
