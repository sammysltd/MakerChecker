/**
 * The single fetch layer for the SPA. Every endpoint the UI touches has a
 * typed function here; components never call fetch directly. Same-origin
 * paths under /api (the dev server proxies them; production serves the SPA
 * from the API server itself).
 */

export const API_BASE = "/api";
export const API_KEY_STORAGE = "mc_api_key";
export const UNAUTHORIZED_EVENT = "mc:unauthorized";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`API error ${status}: ${body}`);
    this.name = "ApiError";
  }
}

export function getApiKey(): string | null {
  return localStorage.getItem(API_KEY_STORAGE);
}

export function setApiKey(key: string | null): void {
  if (key === null || key.trim() === "") localStorage.removeItem(API_KEY_STORAGE);
  else localStorage.setItem(API_KEY_STORAGE, key.trim());
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const key = getApiKey();
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }
  return (await res.json()) as T;
}

// ------------------------------------------------------------------- types

export interface ActorRef {
  type: "user" | "agent" | "system";
  id?: string;
  name?: string;
}

export interface AgentStepDef {
  key: string;
  agent: string;
  skills: string[];
  instructions?: string;
  retries?: { max_attempts: number; backoff?: "none" | "exponential" };
  timeout_ms?: number;
}

export interface ApprovalGateStepDef {
  key: string;
  type: "approval_gate";
  title: string;
  approvals?: {
    min_approvals?: number;
    approver_emails?: string[];
    forbid_requester?: boolean;
  };
}

export type FlowStepDef = AgentStepDef | ApprovalGateStepDef;

export interface FlowDefinition {
  name: string;
  steps: FlowStepDef[];
}

export function isApprovalGate(step: FlowStepDef): step is ApprovalGateStepDef {
  return "type" in step && step.type === "approval_gate";
}

export interface RunSummary {
  id: string;
  flow: string;
  version: number;
  status: string;
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

export interface ApprovalDecisionEntry {
  id: string;
  decision: "approved" | "rejected";
  reason: string | null;
  created_at: string;
  decided_by: string | null;
}

export interface RunApproval {
  id: string;
  step_key: string;
  status: string;
  requested_at: string;
  decided_at: string | null;
  reason: string | null;
  decided_by: string | null;
  required_approvals: number;
  decisions: ApprovalDecisionEntry[];
}

export interface AuditEvent {
  seq: string;
  occurred_at: string;
  actor: ActorRef;
  event_type: string;
  payload: Record<string, unknown>;
  hash: string;
}

export interface RunDetail {
  run: RunSummary & {
    definition: FlowDefinition;
    input: Record<string, unknown>;
    triggered_by: ActorRef;
  };
  steps: StepRun[];
  approvals: RunApproval[];
  auditEvents: AuditEvent[];
}

export interface PendingApproval {
  id: string;
  run_id: string;
  step_key: string;
  requested_at: string;
  flow: string;
  required_approvals: number;
  approved_count: number;
}

export type VerifyResult =
  | { ok: true; count: number; headHash: string | null }
  | { ok: false; count: number; failedSeq: string; reason: string };

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  status: string;
  model_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  role_id: string;
  role: string;
}

export interface GrantedSkill {
  id: string;
  name: string;
  version: number;
  risk_tier: string;
  status: string;
  granted_at: string;
}

export interface AgentRecentRun {
  id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
}

export interface AgentDetail {
  agent: AgentSummary;
  skills: GrantedSkill[];
  recentRuns: AgentRecentRun[];
}

export interface SkillSummary {
  id: string;
  name: string;
  version: number;
  description: string;
  risk_tier: string;
  status: string;
  created_at: string;
}

export interface GrantHistoryEntry {
  id: string;
  role: string;
  granted_at: string;
  granted_by: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface SkillDetail {
  skill: SkillSummary & {
    input_schema: Record<string, unknown>;
    output_schema: Record<string, unknown>;
    implementation: Record<string, unknown>;
  };
  grantHistory: GrantHistoryEntry[];
}

export interface RoleSummary {
  id: string;
  name: string;
  description: string;
  limits: Record<string, unknown>;
  created_at: string;
  active_grant_count?: number;
}

export interface RoleGrant {
  id: string;
  skill: string;
  version: number;
  risk_tier: string;
  granted_at: string;
  revoked_at: string | null;
}

export interface SodConstraint {
  id: string;
  description: string;
  revoked_at: string | null;
  role_a: string;
  role_b: string;
}

export interface RoleDetail {
  role: RoleSummary;
  grants: RoleGrant[];
  sodConstraints: SodConstraint[];
}

export interface FlowSummary {
  id: string;
  name: string;
  created_at: string;
  latest_version: number | null;
  latest_status: string | null;
}

export interface FlowVersion {
  id: string;
  version: number;
  status: string;
  definition: FlowDefinition;
  created_at: string;
}

export interface FlowDetail {
  flow: { id: string; name: string; created_at: string };
  versions: FlowVersion[];
}

// --------------------------------------------------------------- endpoints

export function listRuns(): Promise<{ runs: RunSummary[] }> {
  return request("/runs");
}

export function getRun(id: string): Promise<RunDetail> {
  return request(`/runs/${encodeURIComponent(id)}`);
}

export function triggerFlow(
  name: string,
  input?: Record<string, unknown>,
): Promise<{ runId: string }> {
  return request(`/flows/${encodeURIComponent(name)}/runs`, {
    method: "POST",
    body: JSON.stringify(input === undefined ? {} : { input }),
  });
}

export function listApprovals(): Promise<{ approvals: PendingApproval[] }> {
  return request("/approvals");
}

export function decideApproval(
  id: string,
  decision: "approved" | "rejected",
  reason?: string,
): Promise<{ ok: boolean }> {
  return request(`/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    body: JSON.stringify(reason === undefined ? { decision } : { decision, reason }),
  });
}

export function verifyAudit(): Promise<VerifyResult> {
  return request("/audit/verify");
}

export function listAgents(): Promise<{ agents: AgentSummary[] }> {
  return request("/agents");
}

export function getAgent(id: string): Promise<AgentDetail> {
  return request(`/agents/${encodeURIComponent(id)}`);
}

export function listSkills(): Promise<{ skills: SkillSummary[] }> {
  return request("/skills");
}

export function getSkill(id: string): Promise<SkillDetail> {
  return request(`/skills/${encodeURIComponent(id)}`);
}

export function listRoles(): Promise<{ roles: RoleSummary[] }> {
  return request("/roles");
}

export function getRole(id: string): Promise<RoleDetail> {
  return request(`/roles/${encodeURIComponent(id)}`);
}

export function listFlows(): Promise<{ flows: FlowSummary[] }> {
  return request("/flows");
}

export function getFlow(name: string): Promise<FlowDetail> {
  return request(`/flows/${encodeURIComponent(name)}`);
}
