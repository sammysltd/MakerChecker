import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";

import {
  EmptyNote,
  ErrorNote,
  Loading,
  PageTitle,
  RelTime,
  RiskBadge,
  SkillChip,
  StatusPill,
} from "../components/ui";
import { getAgent, listAgents } from "../lib/api";

export function AgentsPage() {
  const query = useQuery({ queryKey: ["agents"], queryFn: listAgents });
  if (query.isPending) return <Loading what="agents" />;
  if (query.isError) return <ErrorNote error={query.error} />;
  return (
    <div>
      <PageTitle>Agents</PageTitle>
      <table className="mt-6 w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase tracking-[0.08em] text-stone-400">
            <th className="py-2 pr-4 font-medium">Agent</th>
            <th className="py-2 pr-4 font-medium">Role</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 font-medium">Created</th>
          </tr>
        </thead>
        <tbody>
          {query.data.agents.map((agent) => (
            <tr key={agent.id} className="border-b border-line hover:bg-white">
              <td className="py-2.5 pr-4">
                <Link
                  to="/agents/$agentId"
                  params={{ agentId: agent.id }}
                  className="font-medium text-ink underline-offset-2 hover:underline"
                >
                  {agent.name}
                </Link>
              </td>
              <td className="py-2.5 pr-4 font-mono text-xs text-stone-600">{agent.role}</td>
              <td className="py-2.5 pr-4">
                <StatusPill status={agent.status} />
              </td>
              <td className="py-2.5 text-stone-600">
                <RelTime iso={agent.created_at} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentDetailPage() {
  const params = useParams({ strict: false });
  const agentId = params.agentId ?? "";
  const query = useQuery({ queryKey: ["agent", agentId], queryFn: () => getAgent(agentId) });
  if (query.isPending) return <Loading what="agent" />;
  if (query.isError) return <ErrorNote error={query.error} />;
  const { agent, skills, recentRuns } = query.data;
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <PageTitle>{agent.name}</PageTitle>
        <StatusPill status={agent.status} />
      </div>
      <p className="mt-1.5 text-sm text-stone-600">{agent.description}</p>
      <p className="mt-1 text-xs text-stone-500">
        Role: <span className="font-mono text-ink">{agent.role}</span>
      </p>

      <h2 className="mt-8 text-[11px] font-medium uppercase tracking-[0.1em] text-stone-400">
        Granted skills
      </h2>
      {skills.length === 0 ? (
        <EmptyNote>No skills granted — deny by default.</EmptyNote>
      ) : (
        <ul className="mt-3 space-y-2">
          {skills.map((skill) => (
            <li key={skill.id} className="flex flex-wrap items-center gap-3">
              <SkillChip skillRef={`${skill.name}@${skill.version}`} />
              <RiskBadge tier={skill.risk_tier} />
              <span className="text-xs text-stone-500">
                granted <RelTime iso={skill.granted_at} />
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-8 text-[11px] font-medium uppercase tracking-[0.1em] text-stone-400">
        Recent runs
      </h2>
      {recentRuns.length === 0 ? (
        <EmptyNote>No runs yet.</EmptyNote>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {recentRuns.map((run) => (
            <li key={run.id} className="flex items-center gap-3 text-sm">
              <Link
                to="/runs/$runId"
                params={{ runId: run.id }}
                className="font-mono text-xs text-ink underline underline-offset-2"
              >
                {run.id.slice(0, 8)}
              </Link>
              <StatusPill status={run.status} />
              <span className="text-xs text-stone-500">
                <RelTime iso={run.created_at} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
