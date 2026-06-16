import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";

import {
  EmptyNote,
  ErrorNote,
  Loading,
  PageTitle,
  RelTime,
  RiskBadge,
  StatusPill,
} from "../components/ui";
import { getSkill, listSkills } from "../lib/api";

export function SkillsPage() {
  const query = useQuery({ queryKey: ["skills"], queryFn: listSkills });
  if (query.isPending) return <Loading what="skills" />;
  if (query.isError) return <ErrorNote error={query.error} />;
  return (
    <div>
      <PageTitle>Skill registry</PageTitle>
      <table className="mt-6 w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase tracking-[0.08em] text-stone-400">
            <th className="py-2 pr-4 font-medium">Skill</th>
            <th className="py-2 pr-4 font-medium">Risk tier</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 font-medium">Description</th>
          </tr>
        </thead>
        <tbody>
          {query.data.skills.map((skill) => (
            <tr key={skill.id} className="border-b border-line hover:bg-white">
              <td className="py-2.5 pr-4">
                <Link
                  to="/skills/$skillId"
                  params={{ skillId: skill.id }}
                  className="font-mono text-xs font-medium text-ink underline-offset-2 hover:underline"
                >
                  {skill.name}@{skill.version}
                </Link>
              </td>
              <td className="py-2.5 pr-4">
                <RiskBadge tier={skill.risk_tier} />
              </td>
              <td className="py-2.5 pr-4">
                <StatusPill status={skill.status} />
              </td>
              <td className="py-2.5 text-stone-600">{skill.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SkillDetailPage() {
  const params = useParams({ strict: false });
  const skillId = params.skillId ?? "";
  const query = useQuery({ queryKey: ["skill", skillId], queryFn: () => getSkill(skillId) });
  if (query.isPending) return <Loading what="skill" />;
  if (query.isError) return <ErrorNote error={query.error} />;
  const { skill, grantHistory } = query.data;
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-mono text-xl font-semibold tracking-tight text-ink">
          {skill.name}@{skill.version}
        </h1>
        <RiskBadge tier={skill.risk_tier} />
        <StatusPill status={skill.status} />
      </div>
      <p className="mt-1.5 text-sm text-stone-600">{skill.description}</p>

      <h2 className="mt-8 text-[11px] font-medium uppercase tracking-[0.1em] text-stone-400">
        Grant history
      </h2>
      {grantHistory.length === 0 ? (
        <EmptyNote>Never granted to any role.</EmptyNote>
      ) : (
        <table className="mt-3 w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-[0.08em] text-stone-400">
              <th className="py-2 pr-4 font-medium">Role</th>
              <th className="py-2 pr-4 font-medium">Granted</th>
              <th className="py-2 font-medium">Revoked</th>
            </tr>
          </thead>
          <tbody>
            {grantHistory.map((grant) => (
              <tr key={grant.id} className="border-b border-line">
                <td className="py-2.5 pr-4 font-mono text-xs text-ink">{grant.role}</td>
                <td className="py-2.5 pr-4 text-stone-600">
                  <RelTime iso={grant.granted_at} />
                  {grant.granted_by && (
                    <span className="ml-1.5 text-xs text-stone-400">by {grant.granted_by}</span>
                  )}
                </td>
                <td className="py-2.5">
                  {grant.revoked_at ? (
                    <span className="text-blocked">
                      <RelTime iso={grant.revoked_at} />
                      {grant.revoked_by && (
                        <span className="ml-1.5 text-xs">by {grant.revoked_by}</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-xs text-verified">active</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
