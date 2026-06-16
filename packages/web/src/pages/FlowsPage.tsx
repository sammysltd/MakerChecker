import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";

import { RunTimeline } from "../components/RunTimeline";
import {
  EmptyNote,
  ErrorNote,
  Loading,
  PageTitle,
  RelTime,
  StatusPill,
} from "../components/ui";
import { getFlow, listFlows } from "../lib/api";

export function FlowsPage() {
  const query = useQuery({ queryKey: ["flows"], queryFn: listFlows });
  if (query.isPending) return <Loading what="flows" />;
  if (query.isError) return <ErrorNote error={query.error} />;
  return (
    <div>
      <PageTitle>Flows</PageTitle>
      <table className="mt-6 w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase tracking-[0.08em] text-stone-400">
            <th className="py-2 pr-4 font-medium">Flow</th>
            <th className="py-2 pr-4 font-medium">Latest version</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 font-medium">Created</th>
          </tr>
        </thead>
        <tbody>
          {query.data.flows.map((flow) => (
            <tr key={flow.id} className="border-b border-line hover:bg-white">
              <td className="py-2.5 pr-4">
                <Link
                  to="/flows/$flowName"
                  params={{ flowName: flow.name }}
                  className="font-medium text-ink underline-offset-2 hover:underline"
                >
                  {flow.name}
                </Link>
              </td>
              <td className="py-2.5 pr-4 font-mono text-xs text-stone-600">
                {flow.latest_version != null ? `v${flow.latest_version}` : "—"}
              </td>
              <td className="py-2.5 pr-4">
                {flow.latest_status ? <StatusPill status={flow.latest_status} /> : "—"}
              </td>
              <td className="py-2.5 text-stone-600">
                <RelTime iso={flow.created_at} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Read-only flow visualizer: the run timeline rendered statically. */
export function FlowDetailPage() {
  const params = useParams({ strict: false });
  const flowName = params.flowName ?? "";
  const query = useQuery({ queryKey: ["flow", flowName], queryFn: () => getFlow(flowName) });
  if (query.isPending) return <Loading what="flow" />;
  if (query.isError) return <ErrorNote error={query.error} />;
  const { flow, versions } = query.data;
  const latest = versions[0];
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <PageTitle>{flow.name}</PageTitle>
        {latest && (
          <>
            <span className="font-mono text-sm text-stone-400">v{latest.version}</span>
            <StatusPill status={latest.status} />
          </>
        )}
      </div>

      {latest ? (
        <div className="mt-8">
          <h2 className="mb-4 text-[11px] font-medium uppercase tracking-[0.1em] text-stone-400">
            Definition
          </h2>
          <RunTimeline definition={latest.definition} />
        </div>
      ) : (
        <EmptyNote>No versions published.</EmptyNote>
      )}

      {versions.length > 1 && (
        <div className="mt-8">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.1em] text-stone-400">
            Version history
          </h2>
          <ul className="mt-3 space-y-1.5">
            {versions.map((version) => (
              <li key={version.id} className="flex items-center gap-3 text-sm">
                <span className="font-mono text-xs text-ink">v{version.version}</span>
                <StatusPill status={version.status} />
                <span className="text-xs text-stone-500">
                  <RelTime iso={version.created_at} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
