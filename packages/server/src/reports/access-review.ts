import type { Pool } from "pg";

import { esc, fmtTime, htmlDocument } from "./html.js";

/**
 * The periodic access review an auditor actually asks for: for every role,
 * who (which agents) holds it, what it can do right now (active grants),
 * the full grant history including revocations, and the SoD constraints
 * binding it. Served as JSON on GET /api/reports/access-review and rendered
 * as a self-contained HTML report by the CLI.
 */

export interface AccessReviewGrant {
  skill: string;
  version: number;
  grantedAt: string;
  grantedBy: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

export interface AccessReviewRole {
  id: string;
  name: string;
  description: string;
  agents: Array<{ name: string; status: string }>;
  activeGrants: Array<{ skill: string; version: number; grantedAt: string; grantedBy: string | null }>;
  grantHistory: AccessReviewGrant[];
  sodConstraints: Array<{
    withRole: string;
    description: string;
    createdAt: string;
    revokedAt: string | null;
  }>;
}

export interface AccessReview {
  generatedAt: string;
  roles: AccessReviewRole[];
}

export async function getAccessReview(pool: Pool): Promise<AccessReview> {
  const roles = await pool.query<{ id: string; name: string; description: string }>(
    "SELECT id, name, description FROM roles ORDER BY name",
  );

  const agents = await pool.query<{ role_id: string; name: string; status: string }>(
    "SELECT role_id, name, status FROM agents ORDER BY name",
  );

  const grants = await pool.query<{
    role_id: string;
    skill: string;
    version: number;
    granted_at: Date;
    granted_by: string | null;
    revoked_at: Date | null;
    revoked_by: string | null;
  }>(
    `SELECT g.role_id, s.name AS skill, s.version,
            g.created_at AS granted_at, gb.email AS granted_by,
            g.revoked_at, rb.email AS revoked_by
       FROM role_skill_grants g
       JOIN skills s ON s.id = g.skill_id
       LEFT JOIN users gb ON gb.id = g.granted_by_user_id
       LEFT JOIN users rb ON rb.id = g.revoked_by_user_id
      ORDER BY g.created_at, s.name, s.version`,
  );

  const sod = await pool.query<{
    role_a_id: string;
    role_b_id: string;
    role_a: string;
    role_b: string;
    description: string;
    created_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT sc.role_a_id, sc.role_b_id, ra.name AS role_a, rb.name AS role_b,
            sc.description, sc.created_at, sc.revoked_at
       FROM sod_constraints sc
       JOIN roles ra ON ra.id = sc.role_a_id
       JOIN roles rb ON rb.id = sc.role_b_id
      ORDER BY sc.created_at`,
  );

  return {
    generatedAt: new Date().toISOString(),
    roles: roles.rows.map((role) => {
      const history: AccessReviewGrant[] = grants.rows
        .filter((g) => g.role_id === role.id)
        .map((g) => ({
          skill: g.skill,
          version: g.version,
          grantedAt: g.granted_at.toISOString(),
          grantedBy: g.granted_by,
          revokedAt: g.revoked_at ? g.revoked_at.toISOString() : null,
          revokedBy: g.revoked_by,
        }));
      return {
        id: role.id,
        name: role.name,
        description: role.description,
        agents: agents.rows
          .filter((a) => a.role_id === role.id)
          .map((a) => ({ name: a.name, status: a.status })),
        activeGrants: history
          .filter((g) => g.revokedAt === null)
          .map(({ skill, version, grantedAt, grantedBy }) => ({
            skill,
            version,
            grantedAt,
            grantedBy,
          })),
        grantHistory: history,
        sodConstraints: sod.rows
          .filter((c) => c.role_a_id === role.id || c.role_b_id === role.id)
          .map((c) => ({
            withRole: c.role_a_id === role.id ? c.role_b : c.role_a,
            description: c.description,
            createdAt: c.created_at.toISOString(),
            revokedAt: c.revoked_at ? c.revoked_at.toISOString() : null,
          })),
      };
    }),
  };
}

export async function renderAccessReviewHtml(pool: Pool): Promise<string> {
  const review = await getAccessReview(pool);

  const roleBlocks = review.roles
    .map((role) => {
      const agentsLine =
        role.agents.length === 0
          ? `<p class="muted">No agents hold this role.</p>`
          : `<p>Held by: ${role.agents
              .map((a) => `${esc(a.name)} <span class="muted">(${esc(a.status)})</span>`)
              .join(", ")}</p>`;

      const activeRows =
        role.activeGrants.length === 0
          ? `<tr><td colspan="3" class="muted">no active grants (deny by default)</td></tr>`
          : role.activeGrants
              .map(
                (g) => `<tr>
  <td class="mono">${esc(g.skill)}@${g.version}</td>
  <td>${esc(fmtTime(g.grantedAt))}</td>
  <td>${esc(g.grantedBy ?? "—")}</td>
</tr>`,
              )
              .join("\n");

      const historyRows =
        role.grantHistory.length === 0
          ? `<tr><td colspan="5" class="muted">no grants ever issued</td></tr>`
          : role.grantHistory
              .map(
                (g) => `<tr${g.revokedAt ? ` class="muted"` : ""}>
  <td class="mono">${esc(g.skill)}@${g.version}</td>
  <td>${esc(fmtTime(g.grantedAt))}</td>
  <td>${esc(g.grantedBy ?? "—")}</td>
  <td>${g.revokedAt ? `REVOKED ${esc(fmtTime(g.revokedAt))}` : "active"}</td>
  <td>${esc(g.revokedBy ?? "—")}</td>
</tr>`,
              )
              .join("\n");

      const sodLines =
        role.sodConstraints.length === 0
          ? `<p class="muted">No segregation-of-duties constraints.</p>`
          : `<ul>${role.sodConstraints
              .map(
                (c) =>
                  `<li>conflicts with <strong>${esc(c.withRole)}</strong>` +
                  `${c.revokedAt ? ` <span class="muted">(revoked ${esc(fmtTime(c.revokedAt))})</span>` : ""}` +
                  `${c.description ? ` — ${esc(c.description)}` : ""}</li>`,
              )
              .join("\n")}</ul>`;

      return `<h2>Role: ${esc(role.name)}</h2>
${role.description ? `<p class="muted">${esc(role.description)}</p>` : ""}
${agentsLine}
<h3>Active grants</h3>
<table>
<tr><th>Skill</th><th>Granted</th><th>Granted by</th></tr>
${activeRows}
</table>
<h3>Grant history (including revocations)</h3>
<table>
<tr><th>Skill</th><th>Granted</th><th>Granted by</th><th>Status</th><th>Revoked by</th></tr>
${historyRows}
</table>
<h3>Segregation of duties</h3>
${sodLines}`;
    })
    .join("\n");

  const body = `<h1>Access review</h1>
<p class="meta">MakerChecker · generated ${esc(review.generatedAt)} ·
${review.roles.length} role(s)</p>
${roleBlocks || `<p class="muted">No roles defined.</p>`}`;

  return htmlDocument("Access review — MakerChecker", body);
}
