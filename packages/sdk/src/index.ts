/**
 * Thin typed client for the MakerChecker API.
 *
 * The method groups below are hand-written against the server routes and the
 * emitted spec in packages/sdk/openapi.json. NOTE: openapi-typescript codegen
 * was deliberately skipped — the surface is small and a codegen step adds
 * friction; keep these types in sync with packages/server/src/app.ts,
 * packages/server/src/api/admin-routes.ts, and
 * packages/server/src/api/proxy-routes.ts when routes change. All API routes
 * live under the /api prefix; only the health probe stays at /healthz.
 */

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

export interface Health {
  status: "ok";
  schemaVersion: number;
}

export type RunStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface RunSummary {
  id: string;
  flow: string;
  version: number;
  status: RunStatus;
  failure_reason: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface StepRun {
  id: string;
  step_index: number;
  step_key: string;
  status: string;
  attempt: number;
  input: unknown;
  output: unknown;
  error: unknown;
  agent: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface ApprovalDecisionRecord {
  id: string;
  decision: "approved" | "rejected";
  reason: string | null;
  created_at: string;
  decided_by: string | null;
}

export interface ApprovalRecord {
  id: string;
  step_key: string;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  decided_at: string | null;
  reason: string | null;
  decided_by: string | null;
  /** n-of-m gates (M13): how many approvals the gate needs to resolve. */
  required_approvals?: number;
  /** Every individual decision recorded against this approval, oldest first. */
  decisions?: ApprovalDecisionRecord[];
}

export interface AuditEvent {
  seq: string;
  occurred_at: string;
  actor: Record<string, unknown>;
  event_type: string;
  payload: Record<string, unknown>;
  hash: string;
}

export interface RunDetail {
  run: Record<string, unknown> & { id: string; flow: string; status: RunStatus };
  steps: StepRun[];
  approvals: ApprovalRecord[];
  auditEvents: AuditEvent[];
}

export interface PendingApproval {
  id: string;
  run_id: string;
  step_key: string;
  requested_at: string;
  flow: string;
  /** n-of-m gates (M13): quorum and approvals collected so far. */
  required_approvals?: number;
  approved_count?: number;
  /** Ops signals (M15): pending longer than the configured overdue threshold. */
  overdue?: boolean;
  age_seconds?: number;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  status: "active" | "suspended" | "retired";
  model_config: Record<string, unknown>;
  role_id: string;
  role?: string;
  created_at: string;
  updated_at: string;
}

export interface AgentDetail {
  agent: Agent;
  skills: Array<{ id: string; name: string; version: number; risk_tier: string }>;
  recentRuns: Array<{ id: string; status: RunStatus; created_at: string }>;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  limits: Record<string, unknown>;
  created_at: string;
  active_grant_count?: number;
}

export interface Skill {
  id: string;
  name: string;
  version: number;
  description: string;
  risk_tier: "low" | "medium" | "high";
  status: "published" | "deprecated";
  created_at: string;
}

export interface Grant {
  id: string;
  role_id: string;
  skill_id: string;
  created_at: string;
  revoked_at: string | null;
}

export interface ProxySession {
  id: string;
  label: string;
  external_ref: string | null;
  status: "open" | "closed";
  created_by_user_id: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface ProxyAction {
  id: string;
  agent_id: string;
  agent: string;
  role_id_snapshot: string;
  skill_id: string | null;
  skill_ref: string;
  decision: "allowed" | "denied";
  created_at: string;
}

export type ProxyCheckResult =
  | { allowed: true; checkId: string }
  | { allowed: false; code: string; reason: string };

export interface ProxySessionDetail {
  session: ProxySession;
  actions: ProxyAction[];
  auditEvents: AuditEvent[];
}

export interface OpenProxySessionInput {
  label: string;
  externalRef?: string;
}

export interface ProxyCheckInput {
  agentName: string;
  skillRef: string;
  input?: Record<string, unknown>;
}

export interface ProxyRecordInput {
  checkId: string;
  output?: unknown;
  error?: unknown;
}

export type AuditVerifyResult =
  | { ok: true; count: number; headHash: string | null }
  | { ok: false; count: number; failedSeq: string; reason: string };

export interface CreateAgentInput {
  name: string;
  description?: string;
  roleId?: string;
  roleName?: string;
  modelConfig?: Record<string, unknown>;
}

export interface CreateRoleInput {
  name: string;
  description?: string;
  limits?: Record<string, unknown>;
}

export interface PublishSkillInput {
  name: string;
  version: number;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  implementation: Record<string, unknown>;
  riskTier: "low" | "medium" | "high";
}

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`API request failed with status ${status}`);
  }
}

export function createClient(options: ClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.apiKey !== undefined) {
      headers["authorization"] = `Bearer ${options.apiKey}`;
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw new ApiError(res.status, await res.text());
    }
    return (await res.json()) as T;
  }

  const get = <T>(path: string): Promise<T> => request<T>("GET", path);

  return {
    health: () => get<Health>("/healthz"),

    flows: {
      trigger: (name: string, input?: Record<string, unknown>) =>
        request<{ runId: string }>(
          "POST",
          `/api/flows/${encodeURIComponent(name)}/runs`,
          input !== undefined ? { input } : {},
        ),
    },

    runs: {
      list: () => get<{ runs: RunSummary[] }>("/api/runs"),
      get: (id: string) => get<RunDetail>(`/api/runs/${id}`),
    },

    approvals: {
      list: () => get<{ approvals: PendingApproval[] }>("/api/approvals"),
      decide: (id: string, decision: "approved" | "rejected", reason?: string) =>
        request<{ ok: boolean }>("POST", `/api/approvals/${id}/decision`, {
          decision,
          ...(reason !== undefined ? { reason } : {}),
        }),
    },

    agents: {
      list: () => get<{ agents: Agent[] }>("/api/agents"),
      create: (input: CreateAgentInput) => request<{ agent: Agent }>("POST", "/api/agents", input),
      get: (id: string) => get<AgentDetail>(`/api/agents/${id}`),
      setStatus: (id: string, status: Agent["status"]) =>
        request<{ agent: Agent }>("POST", `/api/agents/${id}/status`, { status }),
    },

    roles: {
      list: () => get<{ roles: Role[] }>("/api/roles"),
      create: (input: CreateRoleInput) => request<{ role: Role }>("POST", "/api/roles", input),
    },

    skills: {
      list: () => get<{ skills: Skill[] }>("/api/skills"),
      publish: (input: PublishSkillInput) => request<{ skill: Skill }>("POST", "/api/skills", input),
      deprecate: (id: string) => request<{ skill: Skill }>("POST", `/api/skills/${id}/deprecate`),
    },

    grants: {
      create: (input: { roleId: string; skillId: string }) =>
        request<{ grant: Grant }>("POST", "/api/grants", input),
      revoke: (id: string) => request<{ grant: Grant }>("POST", `/api/grants/${id}/revoke`),
    },

    audit: {
      verify: () => get<AuditVerifyResult>("/api/audit/verify"),
    },

    proxy: {
      openSession: (input: OpenProxySessionInput) =>
        request<{ session: ProxySession }>("POST", "/api/proxy/sessions", {
          label: input.label,
          ...(input.externalRef !== undefined ? { externalRef: input.externalRef } : {}),
        }),
      check: (sessionId: string, input: ProxyCheckInput) =>
        request<ProxyCheckResult>("POST", `/api/proxy/sessions/${sessionId}/check`, {
          agentName: input.agentName,
          skillRef: input.skillRef,
          ...(input.input !== undefined ? { input: input.input } : {}),
        }),
      record: (sessionId: string, input: ProxyRecordInput) =>
        request<{ ok: boolean }>("POST", `/api/proxy/sessions/${sessionId}/record`, {
          checkId: input.checkId,
          ...(input.output !== undefined ? { output: input.output } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
        }),
      closeSession: (sessionId: string) =>
        request<{ session: ProxySession }>("POST", `/api/proxy/sessions/${sessionId}/close`),
      getSession: (sessionId: string) =>
        get<ProxySessionDetail>(`/api/proxy/sessions/${sessionId}`),
    },
  };
}

export type Client = ReturnType<typeof createClient>;

/** Thrown by governedTool wrappers when MakerChecker denies the call. */
export class GovernanceDeniedError extends Error {
  override name = "GovernanceDeniedError";
  constructor(
    readonly code: string,
    readonly reason: string,
  ) {
    super(`governance denied (${code}): ${reason}`);
  }
}

/**
 * Wraps a tool function from ANY agent framework (LangGraph, CrewAI, Claude
 * Agent SDK, plain functions) so every invocation passes through MakerChecker
 * first: check -> denied throws GovernanceDeniedError -> run -> record the
 * output (or the error, which is rethrown). The framework stays the executor;
 * MakerChecker is the authorization checkpoint and the evidentiary record.
 */
export function governedTool<TInput extends Record<string, unknown>, TOutput>(
  client: Client,
  sessionId: string,
  agentName: string,
  skillRef: string,
  fn: (input: TInput) => TOutput | Promise<TOutput>,
): (input: TInput) => Promise<TOutput> {
  return async (input: TInput): Promise<TOutput> => {
    const check = await client.proxy.check(sessionId, { agentName, skillRef, input });
    if (!check.allowed) {
      throw new GovernanceDeniedError(check.code, check.reason);
    }
    try {
      const output = await fn(input);
      await client.proxy.record(sessionId, {
        checkId: check.checkId,
        ...(output !== undefined ? { output } : {}),
      });
      return output;
    } catch (err) {
      await client.proxy.record(sessionId, {
        checkId: check.checkId,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  };
}
