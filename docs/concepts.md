# Concepts

MakerChecker models AI agents the way a bank models employees: an agent is an identity, its role defines what it may do, and nothing is permitted unless explicitly granted. Everything below maps directly to the schema in `packages/server/migrations/`.

A design rule applies throughout: **governed entities are never edited in place.** Skills and flow versions are immutable once published; grants and SoD constraints are revoked, never deleted; roles are kept forever. Run-state tables (`flow_runs`, `step_runs`, `approvals`) are mutable working state, but every transition emits an audit event in the same database transaction, so the audit chain is the canonical record.

## Agent

An identity that executes flow steps.

**Key fields:** `name` (unique), `description`, `role_id` (required, exactly one role), `model_config` (LLM provider/model, optional), `status` (`active` | `suspended` | `retired`).

**Invariants:**
- An agent holds exactly one role. Permissions are never attached to agents directly.
- Only `active` agents can execute. Suspending an agent stops it at the next enforcement check, including steps already scheduled.
- Status changes and role reassignments are audited (`agent.status_changed`, `agent.updated`).

## Role

The permission boundary. Grants and SoD constraints attach to roles, not agents.

**Key fields:** `name` (unique), `description`, `limits` (enforced JSON, see below).

**Invariants:**
- Roles cannot be deleted (the API returns 405). They are permanent facts the audit history references.
- **Grants** (`role_skill_grants`): a grant ties a role to one exact skill version. Fields: `role_id`, `skill_id`, `granted_by_user_id`, `created_at`, `revoked_at`, `revoked_by_user_id`. Grants are append-only: revocation sets `revoked_at`, never deletes. The full permission state of any role at any past timestamp is reconstructable from the grant ledger.
- **Deny by default:** an agent may invoke a skill only if its role holds an unrevoked grant for that exact `name@version`. No grant, no execution; there is no bypass path.
- **SoD constraints** (`sod_constraints`): bind **role pairs**, stored in canonical order (`role_a_id < role_b_id`, enforced by a CHECK constraint) so (A,B) and (B,A) cannot both exist, with `scope` (v0: `flow_run`) and `revoked_at`. A role cannot be constrained against itself.

### Limits & budgets

`roles.limits` is an enforced contract (`packages/server/src/engine/limits.ts`), checked immediately before every skill invocation (both executors AND proxy sessions) and before every LLM provider call:

```json
{
  "skills": {
    "post-payment@1": {
      "maxInvocationsPerRun": 2,
      "maxAmountPerInvocation": 10000,
      "amountField": "amount"
    }
  },
  "run": { "maxSkillInvocations": 20, "maxTokens": 50000 }
}
```

- **Counting is conservative.** Per-skill and run-level invocation counts come from the audit chain's `skill.invoked` events for the run: ALL attempts, including ones that errored. Token usage sums the `llm.call` usage payloads. In proxy sessions the per-skill count comes from the session's *allowed* `proxy_actions` (a denied check never acted).
- **Amounts FAIL CLOSED.** If `maxAmountPerInvocation` is set and the input's amount field (`amountField`, default `"amount"`) is missing or non-numeric, the call is DENIED with `limit_amount_unreadable`. An unparseable limit value likewise denies everything it governs. Ambiguity is never a pass.
- **Token budgets trip before the spend.** The budget is checked before each provider call, so an exhausted budget fails the step without another model invocation.
- Every violation lands in the audit chain as `enforcement.limit_violation` (with `via: "proxy"` for proxy denials) and fails the step and run; a violation is never fed back to the model to negotiate with.

## Skill

A versioned, schema-typed capability.

**Key fields:** `name` + `version` (unique together), `description`, `input_schema` / `output_schema` (JSON Schema), `implementation` (`{type: 'mcp' | 'http' | 'local', ...config}`, where MCP skills declare a transport, command, and tool), `risk_tier` (`low` | `medium` | `high`), `status` (`published` | `deprecated`).

**Invariants:**
- Published skills are immutable. A database trigger rejects any update except `published → deprecated` with every other column unchanged; the API returns 405 on PATCH. Changed behaviour means a new version.
- Deprecated skills no longer execute, even where grants still exist.
- `high` risk tier has a structural consequence: a high-risk skill can only run in a step preceded by an approval gate in the flow definition (enforcement check 4 below).

## Trigger

What starts a flow. Stored in `flow_triggers`: `flow_id`, `type` (`cron` | `event` | `manual`), `config`, `enabled`.

**Cron triggers are scheduled at boot** (`packages/server/src/boot/cron.ts`): enabled `cron` triggers are parsed from `config.schedule` (standard 5-field crontab) into graphile-worker cron items, and each firing starts a run of the trigger's **latest published** flow version as `{type: "system", name: "cron"}`. A missing or unparseable schedule is skipped with a logged error, so a broken schedule never fires, and never stops the instance from booting. The trigger is re-checked at fire time, so disabling one after boot quietly stops new runs without a restart; a flow with no published version refuses loudly. Manual runs are started via `POST /api/flows/:name/runs`.

## Flow

A versioned definition of work. `flows` holds the name; `flow_versions` holds `version`, `definition` (JSON), and `status` (`draft` | `published` | `archived`).

The v0 grammar (`packages/shared/src/flow-definition.ts`) is deliberately frozen: **sequential steps only**, no branching, no parallelism, no expressions. Two step kinds:

- **Agent step:** `key`, `agent`, `skills` (list of `name@version` refs), optional `instructions`, `retries` (`max_attempts` 1–10, `backoff` `none` | `exponential`), `timeout_ms` (1s–1h).
- **Approval gate:** `key`, `type: approval_gate`, `title`, optional `approvals`. Parks the run as `waiting_approval` until resolved; rejection fails the run.

**n-of-m named approvals.** A gate may define an `approvals` object: `min_approvals` (quorum, default 1), `approver_emails` (named approver list), `forbid_requester` (default **true** whenever the object is present; explicit `false` allowed). Defining the object switches the gate into identity mode, which FAILS CLOSED: decisions must come from authenticated users; users outside `approver_emails` are denied (403, audited as `approval.decision_denied`); the run's triggering user cannot decide; the same user can never decide twice (409). Each decision is a row in `approval_decisions` and an `approval.decided` audit event carrying the running tally; any single rejection resolves the gate immediately, and it approves when the approved count reaches `required_approvals` (frozen onto the approvals row at gate creation). Resolution is audited as `approval.resolved`. Gates without the object behave exactly as before: one decision, no identity requirement. Publish-time validation rejects `min_approvals` greater than the named approver list.

**Invariants:** definitions are validated at publish time, never at run time; step keys are unique; at least one agent step; no consecutive gates; published versions are immutable (DB trigger) except `published → archived`; drafts are freely editable.

## Run / Audit

A run is one execution of a flow version. `flow_runs` tracks status (`pending`, `running`, `waiting_approval`, `completed`, `failed`, `cancelled`, `timed_out`), `triggered_by`, `input`, and `failure_reason`. `step_runs` tracks each attempt, with inputs, outputs, and errors.

**Snapshot semantics:** when a step starts, the agent's current role is frozen into `step_runs.role_id_snapshot`. SoD is evaluated against these snapshots, so reassigning an agent's role later cannot rewrite who acted as what in a past run.

**The audit chain** (`audit_events`) is append-only and hash-chained:

- Each event's `hash` is SHA-256 over the RFC 8785 canonical JSON of `{id, occurredAt, actor, eventType, entityType, entityId, runId, payload, prevHash}`.
- `seq` (a generated identity column) is **excluded from the hash**: identity columns leave gaps on aborted transactions, so `seq` is storage order only. Chain order is defined solely by `prev_hash` linkage.
- The chain is **genesis-rooted**: the first event is `audit.genesis` with `prev_hash = sha256("makerchecker-genesis:" + instanceId)`, tying the chain to this instance.
- A single writer (`recordEvent`, serialized by a transaction-scoped advisory lock) is the only insert path. Update, delete, and truncate are rejected by triggers.
- State changes and their audit events commit in the **same transaction**: logging is the write path, so the chain cannot silently lag reality.

Full verification rules, including signed export bundles: [docs/audit-spec.md](audit-spec.md).

### Redaction

One configurable hook (`MAKERCHECKER_REDACTION`: `example` selects the built-in regex redactor that masks emails and long digit runs; unset means none) governs sensitive-data exposure at two seams:

- **Write path:** `llm.call` and `skill.invoked` audit payloads pass through the hook *before* they are hashed into the chain, so the chain stores what the hook returns.
- **Read path:** `GET /api/runs/:id` applies the hook to the run input, step input/output/error, and audit payloads in the response, and the evidence-pack HTML reports use the same hook, so the reports never expose more than the API does.

**At-rest rows are raw.** `flow_runs.input` and `step_runs.input/output/error` are stored unredacted; encrypting the database is a deployment concern, not the hook's job. The hook governs *exposure*, not storage. Deployments with real PII obligations should supply their own hook in place of the example redactor.

## Enforcement

Before an agent step executes, `enforce()` (`packages/server/src/engine/enforcement.ts`) checks, in order:

1. **Agent exists and is active.**
2. **Every skill ref exists and is published** (deprecated skills are refused).
3. **Every skill is granted** to the agent's role: an exact, unrevoked grant of that `name@version`. Deny by default.
4. **Risk tier / gate:** high-risk skills require an approval gate earlier in the flow.
5. **Segregation of duties:** if any role that already completed a step in this run forms an active constraint pair with this agent's role (checked against frozen `role_id_snapshot`s), the run is blocked and `enforcement.sod_violation` lands in the audit chain.

**Checked twice.** Enforcement runs at *decision time* (when the orchestrator schedules the step) and again at *invocation time* (immediately before execution). Grants revoked or agents suspended between scheduling and execution are still caught; the second check records the block with `at: "invocation"` in its audit payload.

## Proxy sessions (governance middleware)

For agents that live in an external framework (LangChain, the Claude Agent SDK, or any framework): the framework keeps executing the tools; MakerChecker is the authorization checkpoint and the evidentiary record. **Wrap, don't migrate.**

A **proxy session** (`proxy_sessions`) groups the checks of one external run. Before each tool call, `POST /api/proxy/sessions/:id/check` runs the same checks as `enforce()` (agent active, skill published, unrevoked grant) and evaluates SoD against the distinct role snapshots that already *acted* (decision `allowed`) in the session; denied attempts never enter the actor set. Every check, allowed or denied, lands in `proxy_actions` with a frozen `role_id_snapshot`, plus an audit event (`proxy.check.allowed`, or `enforcement.blocked` / `enforcement.sod_violation` with `via: "proxy"`) in the same transaction. High-risk skills are categorically denied in proxy mode (`high_risk_requires_gate`): there is no approval gate in someone else's loop, so they must run through a governed flow that has one. Tool outcomes are appended with `/record` (`proxy.result.recorded`); `/close` ends the session, and checks against a closed session are refused.

The SDK's `governedTool(client, sessionId, agentName, skillRef, fn)` packages the check → execute → record cycle around any tool function; denials throw `GovernanceDeniedError` before `fn` runs. See [examples/middleware](../examples/middleware/README.md).
