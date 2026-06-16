import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "pg";

import { generateApiKey } from "../auth/api-keys.js";
import { hashPassword } from "../auth/password.js";
import { publishFlowVersion } from "../engine/flows.js";

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const NOTIFY_SERVER = join(SERVER_ROOT, "mcp/notify-server.mjs");

const SEED_ACTOR = { type: "system" as const, id: "seed", name: "demo seed" };

/**
 * Seeds the demo content: the admin user, then four demo casts — Daily Cash
 * Reconciliation (the happy-path recon flow, the self-approval flow that SoD
 * blocks, and the n-of-m high-value-payment flow), AML Alert Triage (an
 * analyst agent, a four-eye SoD constraint against the officer role, and a
 * flow that parks at a BSA-officer gate), MDR Reportability Triage (medical
 * devices: complaints in, regulatory-officer gate on reportability), PV
 * ICSR Processing (medicines: adverse-event cases in, medical-review gate),
 * Gross-to-Net Margin (pharma/medtech commercial: ERP pricing in,
 * finance-controller certification gate before any figure enters the
 * financials), and Cold-Chain Disposition (a temperature excursion in transit:
 * the monitor agent assesses stability and QUARANTINES affected lots ITSELF —
 * holding is the safe direction, allowed and recorded but ungated — while the
 * one-way release-or-destroy decision is gated to a named QA person; a
 * high-risk disposition skill structurally forces that gate). Idempotent: each
 * cast is guarded by its flagship flow name, so seeding is safe on every boot —
 * including boots of databases seeded before a cast existed.
 */
export async function seedDemo(pool: Pool): Promise<void> {
  await seedAdmin(pool);
  await seedRecon(pool);
  await seedAml(pool);
  await seedMdr(pool);
  await seedPv(pool);
  await seedGtn(pool);
  await seedColdChain(pool);
}

async function seedAdmin(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin)
     VALUES ($1, $2, 'Demo Admin', true) ON CONFLICT (email) DO NOTHING`,
    ["admin@makerchecker.local", await hashPassword("makerchecker-demo")],
  );

  const admin = await pool.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [
    "admin@makerchecker.local",
  ]);
  const adminId = admin.rows[0]!.id;
  const existingKey = await pool.query("SELECT 1 FROM api_keys WHERE user_id = $1", [adminId]);
  if (existingKey.rows.length === 0) {
    const key = await generateApiKey(pool, { userId: adminId, name: "demo-admin" });
    // Plaintext is shown exactly once, at seed time; only its hash is stored.
    console.log(
      `\n[makerchecker] DEMO ADMIN API KEY (shown once — copy it now): ${key.plaintext}\n`,
    );
  }

  // A second identity, so identity-mode gates (forbid_requester) are decidable
  // in the live demo: whoever triggers a run cannot approve it — the officer can.
  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin)
     VALUES ($1, $2, 'Demo Approving Officer', false) ON CONFLICT (email) DO NOTHING`,
    ["officer@makerchecker.local", await hashPassword("makerchecker-demo")],
  );
  const officer = await pool.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [
    "officer@makerchecker.local",
  ]);
  const officerId = officer.rows[0]!.id;
  const existingOfficerKey = await pool.query("SELECT 1 FROM api_keys WHERE user_id = $1", [
    officerId,
  ]);
  if (existingOfficerKey.rows.length === 0) {
    const key = await generateApiKey(pool, { userId: officerId, name: "demo-officer" });
    console.log(
      `[makerchecker] DEMO OFFICER API KEY (for approving gated decisions): ${key.plaintext}\n`,
    );
  }
}

async function seedRecon(pool: Pool): Promise<void> {
  const seeded = await pool.query("SELECT 1 FROM flows WHERE name = 'daily-cash-reconciliation'");
  if (seeded.rows.length > 0) return;

  await pool.query(
    `INSERT INTO roles (name, description) VALUES
     ('recon-preparer-role', 'Prepares reconciliations: ingests data, matches, flags exceptions'),
     ('recon-reporter-role', 'Reports completed reconciliations after human approval'),
     ('recon-approver-role', 'Approves reconciliations (conflicts with preparer by SoD)')
     ON CONFLICT (name) DO NOTHING`,
  );

  await pool.query(
    `INSERT INTO sod_constraints (role_a_id, role_b_id, description)
     SELECT least(p.id, a.id), greatest(p.id, a.id),
            'maker-checker: the preparer of a reconciliation may not also approve it'
       FROM roles p, roles a
      WHERE p.name = 'recon-preparer-role' AND a.name = 'recon-approver-role'
        AND NOT EXISTS (
          SELECT 1 FROM sod_constraints sc
           WHERE sc.role_a_id = least(p.id, a.id) AND sc.role_b_id = greatest(p.id, a.id))`,
  );

  await pool.query(
    `INSERT INTO agents (name, description, role_id, model_config)
     SELECT v.name, v.description, r.id, '{}'::jsonb
       FROM (VALUES
         ('recon-preparer', 'Ingests statement and ledger, matches transactions, flags exceptions', 'recon-preparer-role'),
         ('recon-reporter', 'Generates and delivers the reconciliation summary', 'recon-reporter-role'),
         ('recon-approver-bot', 'Demo agent: tries to approve reconciliations (blocked by SoD)', 'recon-approver-role')
       ) AS v(name, description, role_name)
       JOIN roles r ON r.name = v.role_name
     ON CONFLICT (name) DO NOTHING`,
  );

  const skills: Array<[string, string, Record<string, unknown>]> = [
    ["csv-ingest", "Read the bank statement and ledger CSV files from disk.", { type: "local" }],
    ["txn-match", "Match statement transactions against ledger entries and flag exceptions.", { type: "local" }],
    ["report-gen", "Render the reconciliation summary report.", { type: "local" }],
    ["approve-recon", "Mark a reconciliation as approved.", { type: "local" }],
    [
      "notify",
      "Deliver a notification message to a channel.",
      {
        type: "mcp",
        transport: "stdio",
        command: process.execPath,
        args: [NOTIFY_SERVER],
        tool: "notify",
      },
    ],
  ];
  for (const [name, description, implementation] of skills) {
    await pool.query(
      `INSERT INTO skills (name, version, description, input_schema, output_schema, implementation, risk_tier)
       VALUES ($1, 1, $2, '{}', '{}', $3, 'low') ON CONFLICT DO NOTHING`,
      [name, description, JSON.stringify(implementation)],
    );
  }

  const grants: Array<[string, string]> = [
    ["recon-preparer-role", "csv-ingest"],
    ["recon-preparer-role", "txn-match"],
    ["recon-reporter-role", "report-gen"],
    ["recon-reporter-role", "notify"],
    ["recon-approver-role", "approve-recon"],
  ];
  for (const [roleName, skillName] of grants) {
    await pool.query(
      `INSERT INTO role_skill_grants (role_id, skill_id)
       SELECT r.id, s.id FROM roles r, skills s
        WHERE r.name = $1 AND s.name = $2 AND s.version = 1
          AND NOT EXISTS (
            SELECT 1 FROM role_skill_grants g
             WHERE g.role_id = r.id AND g.skill_id = s.id AND g.revoked_at IS NULL)`,
      [roleName, skillName],
    );
  }

  const recon = await publishFlowVersion(pool, {
    actor: SEED_ACTOR,
    definition: {
      name: "daily-cash-reconciliation",
      steps: [
        {
          key: "prepare",
          agent: "recon-preparer",
          skills: ["csv-ingest@1", "txn-match@1"],
          instructions:
            "Ingest the bank statement and ledger CSVs, match transactions, and produce the exception list.",
          retries: { max_attempts: 3, backoff: "exponential" },
          timeout_ms: 120_000,
        },
        {
          key: "exception_review",
          type: "approval_gate",
          title: "Review the exception list before reporting",
        },
        {
          key: "report",
          agent: "recon-reporter",
          skills: ["report-gen@1", "notify@1"],
          instructions:
            "Generate the reconciliation summary report and deliver it to the #recon channel.",
          timeout_ms: 120_000,
        },
      ],
    },
  });

  await publishFlowVersion(pool, {
    actor: SEED_ACTOR,
    definition: {
      name: "self-approval-attempt",
      steps: [
        {
          key: "prepare",
          agent: "recon-preparer",
          skills: ["csv-ingest@1", "txn-match@1"],
          instructions: "Prepare the reconciliation.",
        },
        {
          key: "approve",
          agent: "recon-approver-bot",
          skills: ["approve-recon@1"],
          instructions: "Approve the reconciliation.",
        },
      ],
    },
  });

  // n-of-m named approvals demo: releasing a high-value payment batch needs
  // TWO distinct authenticated approvers, and whoever triggered the run can
  // never be one of them (forbid_requester). Reuses the recon agents/skills.
  await publishFlowVersion(pool, {
    actor: SEED_ACTOR,
    definition: {
      name: "high-value-payment",
      steps: [
        {
          key: "prepare",
          agent: "recon-preparer",
          skills: ["csv-ingest@1", "txn-match@1"],
          instructions:
            "Assemble the high-value payment batch from the statement and ledger data.",
          timeout_ms: 120_000,
        },
        {
          key: "dual_authorization",
          type: "approval_gate",
          title: "Two approvers must authorize this payment batch",
          approvals: { min_approvals: 2, forbid_requester: true },
        },
        {
          key: "release",
          agent: "recon-reporter",
          skills: ["report-gen@1", "notify@1"],
          instructions: "Release the authorized batch and notify the payments channel.",
          timeout_ms: 120_000,
        },
      ],
    },
  });

  await pool.query(
    `INSERT INTO flow_triggers (flow_id, type, config)
     VALUES ($1, 'cron', '{"schedule":"0 7 * * 1-5","note":"weekdays 07:00 server time; scheduled by the worker at boot"}')`,
    [recon.flowId],
  );
}

/**
 * AML Alert Triage: the financial-crime demo. An L1 analyst agent ingests and
 * triages the day's alerts; the run parks at a "SAR filing decision" gate for
 * the BSA officer (identity mode, requester forbidden); only then are the SAR
 * narratives drafted and delivered. Assumes seedRecon ran first (notify@1).
 */
async function seedAml(pool: Pool): Promise<void> {
  const seeded = await pool.query("SELECT 1 FROM flows WHERE name = 'aml-alert-triage'");
  if (seeded.rows.length > 0) return;

  // The analyst role carries an enforced per-run cap on alert-ingest. The
  // demo invokes it once per run, so the cap proves limits are present
  // without ever tripping.
  await pool.query(
    `INSERT INTO roles (name, description, limits) VALUES
     ('aml-analyst-role', 'Works AML alerts: ingests, triages, drafts SAR narratives',
      '{"skills":{"alert-ingest@1":{"maxInvocationsPerRun":2}}}'),
     ('aml-officer-role', 'BSA officer: dispositions escalated alerts and decides SAR filings', '{}')
     ON CONFLICT (name) DO NOTHING`,
  );

  await pool.query(
    `INSERT INTO sod_constraints (role_a_id, role_b_id, description)
     SELECT least(an.id, o.id), greatest(an.id, o.id),
            'the analyst who works an alert may not approve its disposition'
       FROM roles an, roles o
      WHERE an.name = 'aml-analyst-role' AND o.name = 'aml-officer-role'
        AND NOT EXISTS (
          SELECT 1 FROM sod_constraints sc
           WHERE sc.role_a_id = least(an.id, o.id) AND sc.role_b_id = greatest(an.id, o.id))`,
  );

  await pool.query(
    `INSERT INTO agents (name, description, role_id, model_config)
     SELECT 'aml-l1-analyst', 'Level-1 analyst: ingests and triages AML alerts, drafts SAR narratives',
            r.id, '{}'::jsonb
       FROM roles r WHERE r.name = 'aml-analyst-role'
     ON CONFLICT (name) DO NOTHING`,
  );

  const skills: Array<[string, string]> = [
    ["alert-ingest", "Read the day's AML alerts from the alerts CSV file."],
    [
      "alert-triage",
      "Rule-based triage: escalate sanctions near-matches and risk scores >= 80, with a rationale per alert.",
    ],
    ["sar-draft", "Draft a SAR narrative for each escalated alert."],
  ];
  for (const [name, description] of skills) {
    await pool.query(
      `INSERT INTO skills (name, version, description, input_schema, output_schema, implementation, risk_tier)
       VALUES ($1, 1, $2, '{}', '{}', '{"type":"local"}', 'low') ON CONFLICT DO NOTHING`,
      [name, description],
    );
  }

  const grants = ["alert-ingest", "alert-triage", "sar-draft", "notify"];
  for (const skillName of grants) {
    await pool.query(
      `INSERT INTO role_skill_grants (role_id, skill_id)
       SELECT r.id, s.id FROM roles r, skills s
        WHERE r.name = 'aml-analyst-role' AND s.name = $1 AND s.version = 1
          AND NOT EXISTS (
            SELECT 1 FROM role_skill_grants g
             WHERE g.role_id = r.id AND g.skill_id = s.id AND g.revoked_at IS NULL)`,
      [skillName],
    );
  }

  await publishFlowVersion(pool, {
    actor: SEED_ACTOR,
    definition: {
      name: "aml-alert-triage",
      steps: [
        {
          key: "triage",
          agent: "aml-l1-analyst",
          skills: ["alert-ingest@1", "alert-triage@1"],
          instructions:
            "Ingest the day's AML alerts and triage them: escalate sanctions near-matches and high-risk structuring patterns with a rationale per alert.",
          retries: { max_attempts: 3, backoff: "exponential" },
          timeout_ms: 120_000,
        },
        {
          key: "sar_decision",
          type: "approval_gate",
          title: "SAR filing decision — BSA officer must disposition the escalated alerts",
          approvals: { min_approvals: 1, forbid_requester: true },
        },
        {
          key: "file",
          agent: "aml-l1-analyst",
          skills: ["sar-draft@1", "notify@1"],
          instructions:
            "Draft the SAR narratives for the approved escalations and notify the FIU channel.",
          timeout_ms: 120_000,
        },
      ],
    },
  });
}

/**
 * MDR Reportability Triage: the medical-devices demo. A complaint analyst
 * agent ingests the day's complaint queue and proposes reportability per
 * 21 CFR 803.50; the run parks at the "reportability decision" gate for the
 * regulatory officer (identity mode, requester forbidden); only then are the
 * MDR report skeletons drafted and delivered. Assumes seedRecon ran first
 * (notify@1).
 */
async function seedMdr(pool: Pool): Promise<void> {
  const seeded = await pool.query("SELECT 1 FROM flows WHERE name = 'mdr-reportability-triage'");
  if (seeded.rows.length > 0) return;

  // The analyst role carries an enforced per-run cap on complaint-ingest. The
  // demo invokes it once per run, so the cap proves limits are present
  // without ever tripping.
  await pool.query(
    `INSERT INTO roles (name, description, limits) VALUES
     ('complaint-analyst-role', 'Works device complaints: ingests, triages reportability, drafts MDRs',
      '{"skills":{"complaint-ingest@1":{"maxInvocationsPerRun":2}}}'),
     ('regulatory-officer-role', 'Regulatory officer: decides MDR reportability for escalated complaints', '{}')
     ON CONFLICT (name) DO NOTHING`,
  );

  await pool.query(
    `INSERT INTO sod_constraints (role_a_id, role_b_id, description)
     SELECT least(an.id, o.id), greatest(an.id, o.id),
            'the analyst who triages a complaint may not decide its reportability'
       FROM roles an, roles o
      WHERE an.name = 'complaint-analyst-role' AND o.name = 'regulatory-officer-role'
        AND NOT EXISTS (
          SELECT 1 FROM sod_constraints sc
           WHERE sc.role_a_id = least(an.id, o.id) AND sc.role_b_id = greatest(an.id, o.id))`,
  );

  await pool.query(
    `INSERT INTO agents (name, description, role_id, model_config)
     SELECT 'mdr-complaint-analyst', 'Complaint analyst: ingests and triages device complaints, drafts MDR reports',
            r.id, '{}'::jsonb
       FROM roles r WHERE r.name = 'complaint-analyst-role'
     ON CONFLICT (name) DO NOTHING`,
  );

  const skills: Array<[string, string]> = [
    ["complaint-ingest", "Read the day's device-complaint queue from the complaints CSV file."],
    [
      "reportability-triage",
      "Rule-based triage: escalate deaths/serious injuries (30-day MDR clock, 21 CFR 803.50) and malfunctions likely to recur, with a rationale per complaint.",
    ],
    ["mdr-draft", "Draft an MDR report skeleton for each escalated complaint."],
  ];
  for (const [name, description] of skills) {
    await pool.query(
      `INSERT INTO skills (name, version, description, input_schema, output_schema, implementation, risk_tier)
       VALUES ($1, 1, $2, '{}', '{}', '{"type":"local"}', 'low') ON CONFLICT DO NOTHING`,
      [name, description],
    );
  }

  const grants = ["complaint-ingest", "reportability-triage", "mdr-draft", "notify"];
  for (const skillName of grants) {
    await pool.query(
      `INSERT INTO role_skill_grants (role_id, skill_id)
       SELECT r.id, s.id FROM roles r, skills s
        WHERE r.name = 'complaint-analyst-role' AND s.name = $1 AND s.version = 1
          AND NOT EXISTS (
            SELECT 1 FROM role_skill_grants g
             WHERE g.role_id = r.id AND g.skill_id = s.id AND g.revoked_at IS NULL)`,
      [skillName],
    );
  }

  await publishFlowVersion(pool, {
    actor: SEED_ACTOR,
    definition: {
      name: "mdr-reportability-triage",
      steps: [
        {
          key: "triage",
          agent: "mdr-complaint-analyst",
          skills: ["complaint-ingest@1", "reportability-triage@1"],
          instructions:
            "Ingest the day's device complaints and propose reportability per complaint: escalate deaths, serious injuries, and malfunctions likely to recur, with the applicable MDR clock and a rationale.",
          retries: { max_attempts: 3, backoff: "exponential" },
          timeout_ms: 120_000,
        },
        {
          key: "reportability_decision",
          type: "approval_gate",
          title: "Reportability decision — regulatory officer sign-off",
          approvals: { min_approvals: 1, forbid_requester: true },
        },
        {
          key: "file",
          agent: "mdr-complaint-analyst",
          skills: ["mdr-draft@1", "notify@1"],
          instructions:
            "Draft the MDR report skeletons for the officer-decided reportable complaints and notify the regulatory channel.",
          timeout_ms: 120_000,
        },
      ],
    },
  });
}

/**
 * PV ICSR Processing: the medicines demo. A case-processor agent ingests the
 * day's adverse-event cases and proposes seriousness/expectedness per
 * 21 CFR 314.80; the run parks at the "medical review" gate for the medical
 * reviewer (identity mode, requester forbidden); only then are the ICSR
 * narratives drafted and delivered. Assumes seedRecon ran first (notify@1).
 */
async function seedPv(pool: Pool): Promise<void> {
  const seeded = await pool.query("SELECT 1 FROM flows WHERE name = 'pv-icsr-processing'");
  if (seeded.rows.length > 0) return;

  // The processor role carries an enforced per-run cap on case-intake. The
  // demo invokes it once per run, so the cap proves limits are present
  // without ever tripping.
  await pool.query(
    `INSERT INTO roles (name, description, limits) VALUES
     ('pv-case-processor-role', 'Processes ICSRs: intakes cases, triages seriousness/expectedness, drafts narratives',
      '{"skills":{"case-intake@1":{"maxInvocationsPerRun":2}}}'),
     ('medical-reviewer-role', 'Medical reviewer: confirms seriousness and expectedness for expedited cases', '{}')
     ON CONFLICT (name) DO NOTHING`,
  );

  await pool.query(
    `INSERT INTO sod_constraints (role_a_id, role_b_id, description)
     SELECT least(p.id, m.id), greatest(p.id, m.id),
            'the processor who triages a case may not perform its medical review'
       FROM roles p, roles m
      WHERE p.name = 'pv-case-processor-role' AND m.name = 'medical-reviewer-role'
        AND NOT EXISTS (
          SELECT 1 FROM sod_constraints sc
           WHERE sc.role_a_id = least(p.id, m.id) AND sc.role_b_id = greatest(p.id, m.id))`,
  );

  await pool.query(
    `INSERT INTO agents (name, description, role_id, model_config)
     SELECT 'pv-case-processor', 'PV case processor: intakes and triages adverse-event cases, drafts ICSR narratives',
            r.id, '{}'::jsonb
       FROM roles r WHERE r.name = 'pv-case-processor-role'
     ON CONFLICT (name) DO NOTHING`,
  );

  const skills: Array<[string, string]> = [
    ["case-intake", "Read the day's adverse-event case queue from the ICSR CSV file."],
    [
      "seriousness-triage",
      "Rule-based triage: serious AND unexpected cases go onto the 15-day expedited clock (21 CFR 314.80), with a rationale per case; the rest route to periodic reporting.",
    ],
    ["narrative-draft", "Draft an ICSR narrative for each expedited case."],
  ];
  for (const [name, description] of skills) {
    await pool.query(
      `INSERT INTO skills (name, version, description, input_schema, output_schema, implementation, risk_tier)
       VALUES ($1, 1, $2, '{}', '{}', '{"type":"local"}', 'low') ON CONFLICT DO NOTHING`,
      [name, description],
    );
  }

  const grants = ["case-intake", "seriousness-triage", "narrative-draft", "notify"];
  for (const skillName of grants) {
    await pool.query(
      `INSERT INTO role_skill_grants (role_id, skill_id)
       SELECT r.id, s.id FROM roles r, skills s
        WHERE r.name = 'pv-case-processor-role' AND s.name = $1 AND s.version = 1
          AND NOT EXISTS (
            SELECT 1 FROM role_skill_grants g
             WHERE g.role_id = r.id AND g.skill_id = s.id AND g.revoked_at IS NULL)`,
      [skillName],
    );
  }

  await publishFlowVersion(pool, {
    actor: SEED_ACTOR,
    definition: {
      name: "pv-icsr-processing",
      steps: [
        {
          key: "intake_triage",
          agent: "pv-case-processor",
          skills: ["case-intake@1", "seriousness-triage@1"],
          instructions:
            "Intake the day's adverse-event cases and propose seriousness/expectedness per case: serious and unexpected cases go onto the 15-day expedited clock with a rationale.",
          retries: { max_attempts: 3, backoff: "exponential" },
          timeout_ms: 120_000,
        },
        {
          key: "medical_review",
          type: "approval_gate",
          title: "Medical review — seriousness and expectedness confirmation",
          approvals: { min_approvals: 1, forbid_requester: true },
        },
        {
          key: "submit",
          agent: "pv-case-processor",
          skills: ["narrative-draft@1", "notify@1"],
          instructions:
            "Draft the ICSR narratives for the reviewer-confirmed expedited cases and notify the PV channel.",
          timeout_ms: 120_000,
        },
      ],
    },
  });
}

/**
 * Gross-to-Net Margin: the pharma/medtech commercial demo. A market-analyst
 * agent extracts the ERP pricing export and assembles the gross-to-net
 * waterfall — net price and margin per SKU after each market's distinct
 * cascade of mandatory rebates, austerity discounts, and clawbacks — then
 * normalizes to a single comparable cross-market view. The run parks at the
 * "margin certification" gate for the finance controller (identity mode,
 * requester forbidden); only then is the rebate-accrual summary drafted and
 * delivered. An SoD constraint binds the two roles: the analyst who builds the
 * margin view may not certify the accrual that enters the financials. Assumes
 * seedRecon ran first (notify@1).
 */
async function seedGtn(pool: Pool): Promise<void> {
  const seeded = await pool.query("SELECT 1 FROM flows WHERE name = 'gross-to-net-margin'");
  if (seeded.rows.length > 0) return;

  // The analyst role carries an enforced per-run cap on erp-extract. The demo
  // invokes it once per run, so the cap proves limits are present without ever
  // tripping. The finance controller's role carries no limits — it only
  // certifies at the gate.
  await pool.query(
    `INSERT INTO roles (name, description, limits) VALUES
     ('gtn-analyst-role', 'Builds the gross-to-net margin view: extracts ERP pricing, computes the waterfall, drafts accruals',
      '{"skills":{"erp-extract@1":{"maxInvocationsPerRun":2}}}'),
     ('finance-controller-role', 'Finance controller: certifies the cross-market margin view before any figure enters the financials', '{}')
     ON CONFLICT (name) DO NOTHING`,
  );

  await pool.query(
    `INSERT INTO sod_constraints (role_a_id, role_b_id, description)
     SELECT least(an.id, c.id), greatest(an.id, c.id),
            'the analyst who builds the margin view may not certify the accrual that enters the financials'
       FROM roles an, roles c
      WHERE an.name = 'gtn-analyst-role' AND c.name = 'finance-controller-role'
        AND NOT EXISTS (
          SELECT 1 FROM sod_constraints sc
           WHERE sc.role_a_id = least(an.id, c.id) AND sc.role_b_id = greatest(an.id, c.id))`,
  );

  await pool.query(
    `INSERT INTO agents (name, description, role_id, model_config)
     SELECT 'gtn-market-analyst', 'Market analyst: extracts ERP pricing, assembles the gross-to-net waterfall, normalizes the comparable margin view, drafts accruals',
            r.id, '{}'::jsonb
       FROM roles r WHERE r.name = 'gtn-analyst-role'
     ON CONFLICT (name) DO NOTHING`,
  );

  const skills: Array<[string, string]> = [
    ["erp-extract", "Read the day's ERP pricing export (list prices and the per-market deduction cascade) from the pricing CSV file."],
    [
      "gtn-waterfall",
      "Compute the gross-to-net waterfall per SKU (net = list * (1 - statutory - austerity - clawback)) and net margin; build the per-market and consolidated comparable view; FLAG rows whose total deduction reaches 100% of list or whose net is non-positive as data_integrity_exceptions.",
    ],
    ["accrual-draft", "Draft the rebate-accrual summary for the certified figures."],
  ];
  for (const [name, description] of skills) {
    await pool.query(
      `INSERT INTO skills (name, version, description, input_schema, output_schema, implementation, risk_tier)
       VALUES ($1, 1, $2, '{}', '{}', '{"type":"local"}', 'low') ON CONFLICT DO NOTHING`,
      [name, description],
    );
  }

  const grants = ["erp-extract", "gtn-waterfall", "accrual-draft", "notify"];
  for (const skillName of grants) {
    await pool.query(
      `INSERT INTO role_skill_grants (role_id, skill_id)
       SELECT r.id, s.id FROM roles r, skills s
        WHERE r.name = 'gtn-analyst-role' AND s.name = $1 AND s.version = 1
          AND NOT EXISTS (
            SELECT 1 FROM role_skill_grants g
             WHERE g.role_id = r.id AND g.skill_id = s.id AND g.revoked_at IS NULL)`,
      [skillName],
    );
  }

  await publishFlowVersion(pool, {
    actor: SEED_ACTOR,
    definition: {
      name: "gross-to-net-margin",
      steps: [
        {
          key: "build",
          agent: "gtn-market-analyst",
          skills: ["erp-extract@1", "gtn-waterfall@1"],
          instructions:
            "Extract the ERP pricing export, assemble the gross-to-net waterfall per market and SKU, normalize to a comparable cross-market margin view, and flag any row whose deductions exceed 100% of list as a data-integrity exception.",
          retries: { max_attempts: 3, backoff: "exponential" },
          timeout_ms: 120_000,
        },
        {
          key: "margin_certification",
          type: "approval_gate",
          title: "Cross-market margin sign-off and accrual certification",
          approvals: { min_approvals: 1, forbid_requester: true },
        },
        {
          key: "certify",
          agent: "gtn-market-analyst",
          skills: ["accrual-draft@1", "notify@1"],
          instructions:
            "Draft the rebate-accrual summary for the controller-certified comparable margin view and notify the finance channel.",
          timeout_ms: 120_000,
        },
      ],
    },
  });
}

/**
 * Cold-Chain Disposition: the safe/consequential ASYMMETRY demo. A vaccine /
 * biologic pallet suffers a temperature excursion in transit. A cold-chain
 * monitor agent ingests the excursion log and the validated stability limits,
 * assesses each affected lot (within / beyond / borderline), and QUARANTINES
 * the affected lots ITSELF — holding is the SAFE direction, so it is allowed
 * and recorded but needs no gate. The one-way door — release vs destroy, six
 * figures either way — is owned by a named QA person at the disposition_decision
 * gate. disposition-act@1 is risk_tier 'high', so the flow grammar structurally
 * forces an approval gate before the step that uses it (the
 * high_risk_requires_gate rule). An SoD constraint binds the two roles: the
 * monitor who assesses an excursion may not own its final disposition. Assumes
 * seedRecon ran first (notify@1).
 */
async function seedColdChain(pool: Pool): Promise<void> {
  const seeded = await pool.query("SELECT 1 FROM flows WHERE name = 'cold-chain-disposition'");
  if (seeded.rows.length > 0) return;

  // The monitor role carries an enforced, NON-TRIGGERING per-run cap on
  // excursion-ingest. The demo invokes it once per run, so the cap proves
  // limits are present without ever tripping. The QA-release role carries no
  // limits — it only owns the one-way disposition decision at the gate.
  await pool.query(
    `INSERT INTO roles (name, description, limits) VALUES
     ('cold-chain-monitor-role', 'Monitors cold-chain excursions: ingests data, assesses stability, quarantines affected lots, executes the QA-approved disposition',
      '{"skills":{"excursion-ingest@1":{"maxInvocationsPerRun":2}}}'),
     ('qa-release-role', 'QA release: owns the one-way release-or-destroy disposition of excursion-affected lots', '{}')
     ON CONFLICT (name) DO NOTHING`,
  );

  await pool.query(
    `INSERT INTO sod_constraints (role_a_id, role_b_id, description)
     SELECT least(m.id, q.id), greatest(m.id, q.id),
            'the monitor who assesses an excursion may not own its final disposition'
       FROM roles m, roles q
      WHERE m.name = 'cold-chain-monitor-role' AND q.name = 'qa-release-role'
        AND NOT EXISTS (
          SELECT 1 FROM sod_constraints sc
           WHERE sc.role_a_id = least(m.id, q.id) AND sc.role_b_id = greatest(m.id, q.id))`,
  );

  await pool.query(
    `INSERT INTO agents (name, description, role_id, model_config)
     SELECT 'cold-chain-monitor', 'Cold-chain monitor: ingests excursions, assesses stability, quarantines affected lots, executes the QA-approved disposition',
            r.id, '{}'::jsonb
       FROM roles r WHERE r.name = 'cold-chain-monitor-role'
     ON CONFLICT (name) DO NOTHING`,
  );

  // disposition-act@1 is HIGH risk: it walks the one-way door (release/destroy).
  // The high tier is exactly what makes the flow grammar demand a preceding
  // gate. The other three are low risk: ingest, assess, and quarantine are all
  // safe-direction or read-only. notify@1 was seeded by seedRecon.
  const skills: Array<[string, string, "low" | "high"]> = [
    ["excursion-ingest", "Read the excursion log and the validated stability limits, joining each affected lot to the limits for its product.", "low"],
    [
      "stability-assess",
      "Assess each affected lot against its validated stability limits: within (releasable), beyond (destroy), or borderline (the human-judgment moment); output the assessed lots with rationale and recommended disposition, plus a hold list.",
      "low",
    ],
    ["quarantine", "Mark the affected lots held — the safe direction; the agent may do this without a gate.", "low"],
    [
      "disposition-act",
      "Execute the one-way release-or-destroy decision per lot. HIGH risk: it structurally requires a preceding approval gate.",
      "high",
    ],
  ];
  for (const [name, description, riskTier] of skills) {
    await pool.query(
      `INSERT INTO skills (name, version, description, input_schema, output_schema, implementation, risk_tier)
       VALUES ($1, 1, $2, '{}', '{}', '{"type":"local"}', $3) ON CONFLICT DO NOTHING`,
      [name, description, riskTier],
    );
  }

  const grants = [
    "excursion-ingest",
    "stability-assess",
    "quarantine",
    "disposition-act",
    "notify",
  ];
  for (const skillName of grants) {
    await pool.query(
      `INSERT INTO role_skill_grants (role_id, skill_id)
       SELECT r.id, s.id FROM roles r, skills s
        WHERE r.name = 'cold-chain-monitor-role' AND s.name = $1 AND s.version = 1
          AND NOT EXISTS (
            SELECT 1 FROM role_skill_grants g
             WHERE g.role_id = r.id AND g.skill_id = s.id AND g.revoked_at IS NULL)`,
      [skillName],
    );
  }

  await publishFlowVersion(pool, {
    actor: SEED_ACTOR,
    definition: {
      name: "cold-chain-disposition",
      steps: [
        {
          key: "assess",
          agent: "cold-chain-monitor",
          skills: ["excursion-ingest@1", "stability-assess@1", "quarantine@1"],
          instructions:
            "Ingest the excursion log and the validated stability limits, assess each affected lot (within / beyond / borderline) with a rationale and a recommended disposition, and quarantine every affected lot — holding is the safe direction and needs no gate.",
          retries: { max_attempts: 3, backoff: "exponential" },
          timeout_ms: 120_000,
        },
        {
          key: "disposition_decision",
          type: "approval_gate",
          title: "Disposition decision — QA release or destroy",
          approvals: { min_approvals: 1, forbid_requester: true },
        },
        {
          key: "act",
          agent: "cold-chain-monitor",
          skills: ["disposition-act@1", "notify@1"],
          instructions:
            "Execute the QA-decided disposition: release the within-spec lots, destroy the beyond-spec lots, leave borderline lots held for QA judgment, and notify the cold-chain channel.",
          timeout_ms: 120_000,
        },
      ],
    },
  });
}
