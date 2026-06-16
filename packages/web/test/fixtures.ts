import type {
  AgentDetail,
  AgentSummary,
  AuditEvent,
  FlowDetail,
  FlowSummary,
  PendingApproval,
  RoleDetail,
  RoleSummary,
  RunApproval,
  RunDetail,
  RunSummary,
  SkillDetail,
  SkillSummary,
} from "../src/lib/api";

export const RUN_ID = "11111111-2222-3333-4444-555555555555";

export const runSummary: RunSummary = {
  id: RUN_ID,
  flow: "daily-cash-reconciliation",
  version: 1,
  status: "completed",
  failure_reason: null,
  created_at: "2026-06-12T08:00:00.000Z",
  started_at: "2026-06-12T08:00:01.000Z",
  finished_at: "2026-06-12T08:00:09.400Z",
};

export const auditEvents: AuditEvent[] = [
  {
    seq: "10",
    occurred_at: "2026-06-12T08:00:00.000Z",
    actor: { type: "system", id: "engine" },
    event_type: "run.created",
    payload: {},
    hash: "aaaa1111bbbb2222cccc",
  },
  {
    seq: "11",
    occurred_at: "2026-06-12T08:00:01.000Z",
    actor: { type: "agent", name: "recon-preparer" },
    event_type: "llm.call",
    payload: {
      model: "claude-opus-4-8",
      usage: { inputTokens: 2300, outputTokens: 412 },
    },
    hash: "dddd3333eeee4444ffff",
  },
  {
    seq: "12",
    occurred_at: "2026-06-12T08:00:04.000Z",
    actor: { type: "user", name: "ops@bank.example" },
    event_type: "approval.decided",
    payload: { decision: "approved" },
    hash: "9999aaaa8888bbbb7777",
  },
];

export const sodAuditEvent: AuditEvent = {
  seq: "13",
  occurred_at: "2026-06-12T08:00:05.000Z",
  actor: { type: "system", id: "enforcement" },
  event_type: "enforcement.sod_violation",
  payload: {
    stepKey: "approve",
    code: "sod_violation",
    reason:
      'segregation of duties: role "recon-approver-role" conflicts with "recon-preparer-role" which already acted on this run',
  },
  hash: "5555cccc6666dddd0000",
};

export const runDetail: RunDetail = {
  run: {
    ...runSummary,
    definition: {
      name: "daily-cash-reconciliation",
      steps: [
        {
          key: "prepare",
          agent: "recon-preparer",
          skills: ["csv-ingest@1", "txn-match@1"],
          instructions: "Ingest the CSVs, match transactions, produce the exception list.",
        },
        { key: "exception_review", type: "approval_gate", title: "Review the exception list" },
        {
          key: "report",
          agent: "recon-reporter",
          skills: ["report-gen@1", "notify@1"],
        },
      ],
    },
    input: { statementPath: "/data/bank_statement.csv" },
    triggered_by: { type: "user", name: "ops@bank.example" },
  },
  steps: [
    {
      id: "s1",
      step_index: 0,
      step_key: "prepare",
      status: "completed",
      attempt: 1,
      input: { statementPath: "/data/bank_statement.csv" },
      output: { matchedCount: 10, exceptionCount: 2 },
      error: null,
      agent: "recon-preparer",
      started_at: "2026-06-12T08:00:01.000Z",
      finished_at: "2026-06-12T08:00:03.200Z",
    },
    {
      id: "s2",
      step_index: 2,
      step_key: "report",
      status: "completed",
      attempt: 1,
      input: { exceptions: [] },
      output: { delivered: true, channel: "#recon" },
      error: null,
      agent: "recon-reporter",
      started_at: "2026-06-12T08:00:05.000Z",
      finished_at: "2026-06-12T08:00:09.400Z",
    },
  ],
  approvals: [
    {
      id: "ap1",
      step_key: "exception_review",
      status: "approved",
      requested_at: "2026-06-12T08:00:03.300Z",
      decided_at: "2026-06-12T08:00:04.900Z",
      reason: "Both exceptions explained: Globex invoice typo, ref 88231 under investigation",
      decided_by: "ops@bank.example",
      required_approvals: 1,
      decisions: [
        {
          id: "ad1",
          decision: "approved",
          reason:
            "Both exceptions explained: Globex invoice typo, ref 88231 under investigation",
          created_at: "2026-06-12T08:00:04.900Z",
          decided_by: "ops@bank.example",
        },
      ],
    },
  ],
  auditEvents,
};

/** A 2-of-2 named-approvals gate with one approval collected so far. */
export const multiApproval: RunApproval = {
  id: "ap-multi",
  step_key: "exception_review",
  status: "pending",
  requested_at: "2026-06-12T08:00:03.300Z",
  decided_at: null,
  reason: null,
  decided_by: null,
  required_approvals: 2,
  decisions: [
    {
      id: "ad-m1",
      decision: "approved",
      reason: "first sign-off",
      created_at: "2026-06-12T08:00:04.000Z",
      decided_by: "alice@bank.example",
    },
  ],
};

export const sodRunDetail: RunDetail = {
  run: {
    ...runSummary,
    id: "sod-run-id",
    flow: "self-approval-attempt",
    status: "failed",
    failure_reason:
      'enforcement: segregation of duties: role "recon-approver-role" conflicts with "recon-preparer-role"',
    definition: {
      name: "self-approval-attempt",
      steps: [
        { key: "prepare", agent: "recon-preparer", skills: ["csv-ingest@1"] },
        { key: "approve", agent: "recon-approver-bot", skills: ["approve-recon@1"] },
      ],
    },
    input: {},
    triggered_by: { type: "user", name: "api" },
  },
  steps: [
    {
      id: "s1",
      step_index: 0,
      step_key: "prepare",
      status: "completed",
      attempt: 1,
      input: {},
      output: { ok: true },
      error: null,
      agent: "recon-preparer",
      started_at: "2026-06-12T08:00:01.000Z",
      finished_at: "2026-06-12T08:00:02.000Z",
    },
  ],
  approvals: [],
  auditEvents: [...auditEvents.slice(0, 1), sodAuditEvent],
};

export const pendingApprovals: PendingApproval[] = [
  {
    id: "ap-pending-1",
    run_id: RUN_ID,
    step_key: "exception_review",
    requested_at: "2026-06-12T07:58:00.000Z",
    flow: "daily-cash-reconciliation",
    required_approvals: 1,
    approved_count: 0,
  },
];

export const pendingMultiApprovals: PendingApproval[] = [
  {
    id: "ap-pending-2",
    run_id: RUN_ID,
    step_key: "dual_authorization",
    requested_at: "2026-06-12T07:59:00.000Z",
    flow: "high-value-payment",
    required_approvals: 2,
    approved_count: 1,
  },
];

export const flows: FlowSummary[] = [
  {
    id: "f1",
    name: "daily-cash-reconciliation",
    created_at: "2026-06-01T00:00:00.000Z",
    latest_version: 1,
    latest_status: "published",
  },
  {
    id: "f2",
    name: "draft-flow",
    created_at: "2026-06-01T00:00:00.000Z",
    latest_version: null,
    latest_status: null,
  },
];

export const flowDetail: FlowDetail = {
  flow: { id: "f1", name: "daily-cash-reconciliation", created_at: "2026-06-01T00:00:00.000Z" },
  versions: [
    {
      id: "fv2",
      version: 2,
      status: "published",
      definition: runDetail.run.definition,
      created_at: "2026-06-02T00:00:00.000Z",
    },
    {
      id: "fv1",
      version: 1,
      status: "published",
      definition: runDetail.run.definition,
      created_at: "2026-06-01T00:00:00.000Z",
    },
  ],
};

export const agents: AgentSummary[] = [
  {
    id: "ag1",
    name: "recon-preparer",
    description: "Prepares reconciliations",
    status: "active",
    model_config: {},
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    role_id: "ro1",
    role: "recon-preparer-role",
  },
];

export const agentDetail: AgentDetail = {
  agent: agents[0]!,
  skills: [
    {
      id: "sk1",
      name: "csv-ingest",
      version: 1,
      risk_tier: "low",
      status: "published",
      granted_at: "2026-06-01T00:00:00.000Z",
    },
  ],
  recentRuns: [
    {
      id: RUN_ID,
      status: "completed",
      created_at: "2026-06-12T08:00:00.000Z",
      finished_at: "2026-06-12T08:00:09.400Z",
    },
  ],
};

export const skills: SkillSummary[] = [
  {
    id: "sk1",
    name: "csv-ingest",
    version: 1,
    description: "Read the bank statement and ledger CSV files from disk.",
    risk_tier: "low",
    status: "published",
    created_at: "2026-06-01T00:00:00.000Z",
  },
  {
    id: "sk2",
    name: "approve-recon",
    version: 2,
    description: "Mark a reconciliation as approved.",
    risk_tier: "high",
    status: "deprecated",
    created_at: "2026-06-01T00:00:00.000Z",
  },
];

export const skillDetail: SkillDetail = {
  skill: {
    ...skills[0]!,
    input_schema: {},
    output_schema: {},
    implementation: { type: "local" },
  },
  grantHistory: [
    {
      id: "g1",
      role: "recon-preparer-role",
      granted_at: "2026-06-01T00:00:00.000Z",
      granted_by: "admin@makerchecker.local",
      revoked_at: null,
      revoked_by: null,
    },
    {
      id: "g2",
      role: "recon-reporter-role",
      granted_at: "2026-05-01T00:00:00.000Z",
      granted_by: null,
      revoked_at: "2026-05-15T00:00:00.000Z",
      revoked_by: "admin@makerchecker.local",
    },
  ],
};

export const roles: RoleSummary[] = [
  {
    id: "ro1",
    name: "recon-preparer-role",
    description: "Prepares reconciliations",
    limits: {},
    created_at: "2026-06-01T00:00:00.000Z",
    active_grant_count: 2,
  },
];

export const roleDetail: RoleDetail = {
  role: roles[0]!,
  grants: [
    {
      id: "g1",
      skill: "csv-ingest",
      version: 1,
      risk_tier: "low",
      granted_at: "2026-06-01T00:00:00.000Z",
      revoked_at: null,
    },
    {
      id: "g2",
      skill: "txn-match",
      version: 1,
      risk_tier: "medium",
      granted_at: "2026-06-01T00:00:00.000Z",
      revoked_at: "2026-06-05T00:00:00.000Z",
    },
  ],
  sodConstraints: [
    {
      id: "sc1",
      description: "maker-checker: the preparer may not also approve",
      revoked_at: null,
      role_a: "recon-preparer-role",
      role_b: "recon-approver-role",
    },
    {
      id: "sc2",
      description: "old constraint",
      revoked_at: "2026-06-02T00:00:00.000Z",
      role_a: "recon-preparer-role",
      role_b: "recon-reporter-role",
    },
  ],
};
