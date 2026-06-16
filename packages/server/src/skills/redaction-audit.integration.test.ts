import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import type { Json, StepExecutionRequest } from "../engine/executor.js";
import { exampleRegexRedactor, noRedaction } from "../llm/redaction.js";
import {
  checkAndAuthorize,
  closeSession,
  openSession,
  recordResult,
  type ProxyCheckResult,
} from "../proxy/service.js";
import { SkillInvoker } from "./invoker.js";
import { SequentialInvokerExecutor } from "./sequential-executor.js";

/**
 * Write-path redaction is an audit guarantee, so it is attacked, not assumed:
 * a known secret planted in a skill input/output and in a proxy
 * request/response must be MASKED in the hashed audit_events payload — never
 * recorded raw — while the value that actually executes is left untouched.
 *
 * The example regex redactor (email + long digit runs) stands in for a real
 * deployment hook; it is injected directly so the test does not depend on the
 * MAKERCHECKER_REDACTION env var, which other suites in this tree may toggle.
 */

const SECRET_EMAIL = "victim@private.example";
const SECRET_ACCT = "4012888888881881"; // 16-digit "card/account" number
const REDACTED_EMAIL = "[REDACTED:email]";
const REDACTED_NUMBER = "[REDACTED:number]";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await db.drop();
});

/** Reads back the payload of the single audit event of a given type. */
async function eventPayload(
  whereType: string,
  entityId: string,
): Promise<Record<string, unknown>> {
  const { rows } = await db.pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM audit_events
      WHERE event_type = $1 AND entity_id = $2 ORDER BY seq DESC LIMIT 1`,
    [whereType, entityId],
  );
  expect(rows[0], `no ${whereType} event for ${entityId}`).toBeDefined();
  return rows[0]!.payload;
}

describe("SequentialInvokerExecutor write-path redaction", () => {
  // The skill echoes its input AND emits the secret account number on its own,
  // so we can prove both the recorded input and the recorded output are masked.
  const SKILL = "echo-with-secret@1";
  const registry = new Map([
    [
      SKILL,
      async (input: Json): Promise<Json> => ({
        echoed: input,
        leak: `account ${SECRET_ACCT} flagged`,
      }),
    ],
  ]);

  let roleId: string;

  beforeAll(async () => {
    const role = await db.pool.query<{ id: string }>(
      "INSERT INTO roles (name) VALUES ('redact-seq-role') RETURNING id",
    );
    roleId = role.rows[0]!.id;
    await db.pool.query(
      `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
       VALUES ('echo-with-secret', 1, '{}', '{}', '{"type":"local"}', 'low')`,
    );
  });

  function buildReq(): StepExecutionRequest {
    return {
      step: { key: "do-thing", agent: "seq-agent", skills: [SKILL] },
      input: { note: `contact ${SECRET_EMAIL}`, account: SECRET_ACCT },
      signal: new AbortController().signal,
      meta: {
        runId: randomUUID(),
        stepRunId: randomUUID(),
        agentId: randomUUID(),
        agentName: "seq-agent",
        roleId,
        modelConfig: {},
      },
    };
  }

  it("masks the secret in BOTH skill input and output of the skill.invoked event", async () => {
    const exec = new SequentialInvokerExecutor(
      new SkillInvoker(db.pool, registry),
      db.pool,
      exampleRegexRedactor,
    );
    const req = buildReq();

    const output = await exec.execute(req);

    // What EXECUTED is untouched: the skill saw and returned the real secret.
    expect((output.echoed as Json).note).toBe(`contact ${SECRET_EMAIL}`);
    expect(output.leak).toContain(SECRET_ACCT);

    // What was WRITTEN to the audit chain is redacted.
    const payload = await eventPayload("skill.invoked", req.meta.stepRunId);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(SECRET_EMAIL);
    expect(serialized).not.toContain(SECRET_ACCT);

    const recordedInput = payload.input as Record<string, unknown>;
    expect(recordedInput.note).toBe(`contact ${REDACTED_EMAIL}`);
    expect(recordedInput.account).toBe(REDACTED_NUMBER);

    const recordedOutput = payload.output as Record<string, unknown>;
    expect((recordedOutput.echoed as Record<string, unknown>).note).toBe(
      `contact ${REDACTED_EMAIL}`,
    );
    expect(recordedOutput.leak).toBe(`account ${REDACTED_NUMBER} flagged`);
  });

  it("with noRedaction the raw secret is recorded (control: the hook is what masks)", async () => {
    const exec = new SequentialInvokerExecutor(
      new SkillInvoker(db.pool, registry),
      db.pool,
      noRedaction,
    );
    const req = buildReq();
    await exec.execute(req);

    const payload = await eventPayload("skill.invoked", req.meta.stepRunId);
    expect(JSON.stringify(payload)).toContain(SECRET_ACCT);
  });
});

describe("proxy service write-path redaction", () => {
  let sessionId: string;
  const actor = { type: "user" as const, id: "00000000-0000-0000-0000-000000000001" };

  beforeAll(async () => {
    await db.pool.query("INSERT INTO roles (name) VALUES ('redact-proxy-role')");
    await db.pool.query(
      `INSERT INTO agents (name, role_id, status)
       SELECT 'redact-proxy-agent', id, 'active' FROM roles WHERE name = 'redact-proxy-role'`,
    );
    await db.pool.query(
      `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
       VALUES ('redact-proxy-skill', 1, '{}', '{}', '{"type":"local"}', 'low')`,
    );
    await db.pool.query(
      `INSERT INTO role_skill_grants (role_id, skill_id)
       SELECT r.id, s.id FROM roles r, skills s
        WHERE r.name = 'redact-proxy-role' AND s.name = 'redact-proxy-skill' AND s.version = 1`,
    );
    const session = await openSession(db.pool, {
      label: `session for ${SECRET_EMAIL}`,
      externalRef: `acct ${SECRET_ACCT}`,
      actor,
      redact: exampleRegexRedactor,
    });
    sessionId = session.id;
  });

  it("masks label/externalRef in proxy.session.opened", async () => {
    const payload = await eventPayload("proxy.session.opened", sessionId);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(SECRET_EMAIL);
    expect(serialized).not.toContain(SECRET_ACCT);
    expect(payload.label).toBe(`session for ${REDACTED_EMAIL}`);
    expect(payload.externalRef).toBe(`acct ${REDACTED_NUMBER}`);
  });

  it("masks the secret in the intercepted request input of proxy.check.allowed", async () => {
    const result: ProxyCheckResult = await checkAndAuthorize(db.pool, {
      sessionId,
      agentName: "redact-proxy-agent",
      skillRef: "redact-proxy-skill@1",
      input: { recipient: SECRET_EMAIL, account: SECRET_ACCT },
      actor,
      redact: exampleRegexRedactor,
    });
    expect(result.allowed).toBe(true);

    const payload = await eventPayload("proxy.check.allowed", sessionId);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(SECRET_EMAIL);
    expect(serialized).not.toContain(SECRET_ACCT);

    const recordedInput = payload.input as Record<string, unknown>;
    expect(recordedInput.recipient).toBe(REDACTED_EMAIL);
    expect(recordedInput.account).toBe(REDACTED_NUMBER);
  });

  it("masks the secret in the recorded response output of proxy.result.recorded", async () => {
    const check = await checkAndAuthorize(db.pool, {
      sessionId,
      agentName: "redact-proxy-agent",
      skillRef: "redact-proxy-skill@1",
      input: {},
      actor,
      redact: exampleRegexRedactor,
    });
    if (!check.allowed) throw new Error("expected the check to be allowed");

    await recordResult(db.pool, {
      sessionId,
      checkId: check.checkId,
      output: { wired_to: SECRET_EMAIL, ref: SECRET_ACCT },
      actor,
      redact: exampleRegexRedactor,
    });

    const payload = await eventPayload("proxy.result.recorded", sessionId);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(SECRET_EMAIL);
    expect(serialized).not.toContain(SECRET_ACCT);

    const recordedOutput = payload.output as Record<string, unknown>;
    expect(recordedOutput.wired_to).toBe(REDACTED_EMAIL);
    expect(recordedOutput.ref).toBe(REDACTED_NUMBER);
  });

  it("masks the secret in a recorded error of proxy.result.recorded", async () => {
    const check = await checkAndAuthorize(db.pool, {
      sessionId,
      agentName: "redact-proxy-agent",
      skillRef: "redact-proxy-skill@1",
      input: {},
      actor,
      redact: exampleRegexRedactor,
    });
    if (!check.allowed) throw new Error("expected the check to be allowed");

    await recordResult(db.pool, {
      sessionId,
      checkId: check.checkId,
      error: `transfer to ${SECRET_EMAIL} (acct ${SECRET_ACCT}) failed`,
      actor,
      redact: exampleRegexRedactor,
    });

    const payload = await eventPayload("proxy.result.recorded", sessionId);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(SECRET_EMAIL);
    expect(serialized).not.toContain(SECRET_ACCT);
    expect(payload.error).toBe(
      `transfer to ${REDACTED_EMAIL} (acct ${REDACTED_NUMBER}) failed`,
    );
  });

  it("masks the label in proxy.session.closed (run last: it closes the session)", async () => {
    await closeSession(db.pool, { sessionId, actor, redact: exampleRegexRedactor });
    const payload = await eventPayload("proxy.session.closed", sessionId);
    expect(JSON.stringify(payload)).not.toContain(SECRET_EMAIL);
    expect(payload.label).toBe(`session for ${REDACTED_EMAIL}`);
  });
});
