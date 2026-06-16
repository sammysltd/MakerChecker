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
} from "../components/ui";
import { getRole, listRoles } from "../lib/api";

export function RolesPage() {
  const query = useQuery({ queryKey: ["roles"], queryFn: listRoles });
  if (query.isPending) return <Loading what="roles" />;
  if (query.isError) return <ErrorNote error={query.error} />;
  return (
    <div>
      <PageTitle>Roles</PageTitle>
      <table className="mt-6 w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase tracking-[0.08em] text-stone-400">
            <th className="py-2 pr-4 font-medium">Role</th>
            <th className="py-2 pr-4 font-medium">Description</th>
            <th className="py-2 font-medium">Active grants</th>
          </tr>
        </thead>
        <tbody>
          {query.data.roles.map((role) => (
            <tr key={role.id} className="border-b border-line hover:bg-white">
              <td className="py-2.5 pr-4">
                <Link
                  to="/roles/$roleId"
                  params={{ roleId: role.id }}
                  className="font-mono text-xs font-medium text-ink underline-offset-2 hover:underline"
                >
                  {role.name}
                </Link>
              </td>
              <td className="py-2.5 pr-4 text-stone-600">{role.description}</td>
              <td className="py-2.5 font-mono text-xs text-stone-600">
                {role.active_grant_count ?? 0}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RoleDetailPage() {
  const params = useParams({ strict: false });
  const roleId = params.roleId ?? "";
  const query = useQuery({ queryKey: ["role", roleId], queryFn: () => getRole(roleId) });
  if (query.isPending) return <Loading what="role" />;
  if (query.isError) return <ErrorNote error={query.error} />;
  const { role, grants, sodConstraints } = query.data;
  return (
    <div>
      <PageTitle>{role.name}</PageTitle>
      <p className="mt-1.5 text-sm text-stone-600">{role.description}</p>

      <h2 className="mt-8 text-[11px] font-medium uppercase tracking-[0.1em] text-stone-400">
        Skill grants
      </h2>
      {grants.length === 0 ? (
        <EmptyNote>No skills granted — deny by default.</EmptyNote>
      ) : (
        <ul className="mt-3 space-y-2">
          {grants.map((grant) => (
            <li key={grant.id} className="flex flex-wrap items-center gap-3">
              <SkillChip skillRef={`${grant.skill}@${grant.version}`} />
              <RiskBadge tier={grant.risk_tier} />
              <span className="text-xs text-stone-500">
                granted <RelTime iso={grant.granted_at} />
              </span>
              {grant.revoked_at && (
                <span className="text-xs font-medium text-blocked">
                  revoked <RelTime iso={grant.revoked_at} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-8 text-[11px] font-medium uppercase tracking-[0.1em] text-stone-400">
        Segregation-of-duties constraints
      </h2>
      {sodConstraints.length === 0 ? (
        <EmptyNote>No SoD constraints involve this role.</EmptyNote>
      ) : (
        <ul className="mt-3 space-y-2">
          {sodConstraints.map((constraint) => (
            <li
              key={constraint.id}
              className={`border-l-4 px-3 py-2 ${
                constraint.revoked_at
                  ? "border-stone-300 bg-stone-50 text-stone-400"
                  : "border-blocked bg-red-50"
              }`}
            >
              <p className="font-mono text-xs font-medium">
                {constraint.role_a} × {constraint.role_b}
                {constraint.revoked_at && <span className="ml-2">(revoked)</span>}
              </p>
              <p className="mt-0.5 text-xs">{constraint.description}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
