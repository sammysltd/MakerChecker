import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import type { LLMProvider, LLMRequest, LLMTurn } from "../llm/provider.js";
import { exampleRegexRedactor } from "../llm/redaction.js";
import { SkillInvoker } from "../skills/invoker.js";
import type { LocalSkillFn } from "./executor.js";
import { LLMExecutor, toolNameForRef } from "./llm-executor.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures");

let db: TestDb;
const localRegistry = new Map<string, LocalSkillFn>();

/** Scripted provider: returns queued turns in order and records every request. */
class MockProvider implements LLMProvider {
  requests: LLMRequest[] = [];
  private turns: LLMTurn[] = [];

  queue(...turns: LLMTurn[]): this {
    this.turns.push(...turns);
    return this;
  }

  async complete(req: LLMRequest): Promise<LLMTurn> {
    this.requests.push(structuredClone({ ...req, signal: undefined }) as unknown as LLMRequest);
    const turn = this.turns.shift();
    if (!turn) throw new Error("MockProvider queue exhausted");
    return turn;
  }
}

const text = (t: string): LLMTurn => ({
  stopReason: "end_turn",
  content: [{ type: "text", text: t }],
  usage: { inputTokens: 100, outputTokens: 20 },
});

const toolCall = (name: string, input: Record<string, unknown>, id = "call_1"): LLMTurn => ({
  stopReason: "tool_use",
  content: [{ type: "tool_use", id, name, input }],
  usage: { inputTokens: 150, outputTokens: 30 },
});

function makeExecutor(provider: LLMProvider, redact = false): LLMExecutor {
  return new LLMExecutor({
    pool: db.pool,
    providers: { anthropic: provider },
    invoker: new SkillInvoker(db.pool, localRegistry),
    ...(redact ? { redact: exampleRegexRedactor } : {}),
  });
}

// roleId is filled in beforeAll: limits are evaluated against a REAL role row.
const META = {
  runId: "44444444-4444-4444-4444-444444444444",
  stepRunId: "55555555-5555-5555-5555-555555555555",
  agentId: "66666666-6666-6666-6666-666666666666",
  agentName: "test-agent",
  roleId: "",
  modelConfig: { provider: "anthropic", model: "claude-opus-4-8" },
};

function stepReq(skills: string[], input: Record<string, unknown> = {}, runId = META.runId) {
  return {
    step: { key: "work", agent: "test-agent", skills, instructions: "Do the work." },
    input,
    signal: new AbortController().signal,
    meta: { ...META, runId },
  };
}

async function seedSkill(
  ref: string,
  options: {
    fn?: LocalSkillFn;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    implementation?: Record<string, unknown>;
    description?: string;
  } = {},
): Promise<void> {
  const [name, version] = ref.split("@");
  await db.pool.query(
    `INSERT INTO skills (name, version, description, input_schema, output_schema, implementation, risk_tier)
     VALUES ($1, $2, $3, $4, $5, $6, 'low') ON CONFLICT DO NOTHING`,
    [
      name,
      Number(version),
      options.description ?? `Test skill ${ref}`,
      JSON.stringify(options.inputSchema ?? {}),
      JSON.stringify(options.outputSchema ?? {}),
      JSON.stringify(options.implementation ?? { type: "local" }),
    ],
  );
  if (options.fn) localRegistry.set(ref, options.fn);
}

async function auditEvents(runId: string): Promise<Array<{ event_type: string; payload: never }>> {
  const { rows } = await db.pool.query(
    "SELECT event_type, payload FROM audit_events WHERE run_id = $1 ORDER BY seq ASC",
    [runId],
  );
  return rows;
}

const PREV_ALLOW_PRIVATE = process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;

beforeAll(async () => {
  // This suite spins a real http skill server on 127.0.0.1; opt the SSRF guard
  // in for the test process only (production never sets this).
  process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = "1";
  db = await createTestDb();
  const role = await db.pool.query<{ id: string }>(
    "INSERT INTO roles (name) VALUES ('llm-exec-role') RETURNING id",
  );
  META.roleId = role.rows[0]!.id;
}, 60_000);

afterAll(async () => {
  if (PREV_ALLOW_PRIVATE === undefined) delete process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;
  else process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = PREV_ALLOW_PRIVATE;
  await db.drop();
});

describe("LLMExecutor — tool-use loop", () => {
  it("presents EXACTLY the step's permitted skills as tools, executes, audits", async () => {
    const runId = "10000000-0000-0000-0000-000000000001";
    await seedSkill("match-txns@1", {
      fn: async (input) => ({ matched: 41, exceptions: 2, source: input.file }),
      description: "Match bank transactions against the ledger",
    });
    await seedSkill("unused-skill@1", { fn: async (i) => i });

    const provider = new MockProvider().queue(
      toolCall(toolNameForRef("match-txns@1"), { file: "statement.csv" }),
      text("Matched 41 transactions; 2 exceptions flagged."),
    );

    const output = await makeExecutor(provider).execute(stepReq(["match-txns@1"], {}, runId));
    expect(output).toEqual({
      text: "Matched 41 transactions; 2 exceptions flagged.",
      iterations: 2,
    });

    // Tools presented = exactly the permitted set — not "unused-skill@1".
    expect(provider.requests[0]!.tools.map((t) => t.name)).toEqual([
      toolNameForRef("match-txns@1"),
    ]);

    // Tool result fed back to the model on the second call.
    const second = provider.requests[1]!;
    const lastMsg = second.messages.at(-1)!;
    expect(lastMsg.content[0]).toMatchObject({
      type: "tool_result",
      content: JSON.stringify({ matched: 41, exceptions: 2, source: "statement.csv" }),
    });

    const events = await auditEvents(runId);
    expect(events.map((e) => e.event_type)).toEqual(["llm.call", "skill.invoked", "llm.call"]);
  });

  it("feeds hallucinated tool names back as errors so the model can recover", async () => {
    const runId = "10000000-0000-0000-0000-000000000002";
    await seedSkill("real-skill@1", { fn: async () => ({ ok: true }) });

    const provider = new MockProvider().queue(
      toolCall("post_wire_transfer", { amount: 1_000_000 }), // not granted, not real
      text("Understood — that tool is unavailable."),
    );

    const output = await makeExecutor(provider).execute(stepReq(["real-skill@1"], {}, runId));
    expect(output.iterations).toBe(2);

    const second = provider.requests[1]!;
    expect(second.messages.at(-1)!.content[0]).toMatchObject({
      type: "tool_result",
      isError: true,
    });
    const events = await auditEvents(runId);
    const invoked = events.find((e) => e.event_type === "skill.invoked");
    expect(invoked!.payload).toMatchObject({ toolName: "post_wire_transfer" });
  });

  it("rejects input that violates the skill's schema and audits the failure", async () => {
    const runId = "10000000-0000-0000-0000-000000000003";
    await seedSkill("strict-skill@1", {
      fn: async () => ({ ok: true }),
      inputSchema: {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
        additionalProperties: false,
      },
    });

    const provider = new MockProvider().queue(
      toolCall(toolNameForRef("strict-skill@1"), { amount: "not-a-number" }),
      text("Input was invalid."),
    );

    await makeExecutor(provider).execute(stepReq(["strict-skill@1"], {}, runId));
    const second = provider.requests[1]!;
    const result = second.messages.at(-1)!.content[0] as { isError?: boolean; content: string };
    expect(result.isError).toBe(true);
    expect(result.content).toContain("input_invalid");
  });

  it("aborts a runaway loop at the iteration cap", async () => {
    await seedSkill("loop-skill@1", { fn: async () => ({ again: true }) });
    const provider = new MockProvider();
    for (let i = 0; i < 12; i += 1) {
      provider.queue(toolCall(toolNameForRef("loop-skill@1"), {}, `call_${i}`));
    }
    await expect(
      makeExecutor(provider).execute(stepReq(["loop-skill@1"])),
    ).rejects.toThrow(/exceeded 10 iterations/);
  });

  it("fails plainly on model refusal and truncation", async () => {
    await seedSkill("any-skill@1", { fn: async () => ({}) });
    const refusal = new MockProvider().queue({
      stopReason: "refusal",
      content: [],
      usage: { inputTokens: 10, outputTokens: 0 },
    });
    await expect(makeExecutor(refusal).execute(stepReq(["any-skill@1"]))).rejects.toThrow(
      /refused/,
    );

    const truncated = new MockProvider().queue({
      stopReason: "max_tokens",
      content: [{ type: "text", text: "partial..." }],
      usage: { inputTokens: 10, outputTokens: 16000 },
    });
    await expect(makeExecutor(truncated).execute(stepReq(["any-skill@1"]))).rejects.toThrow(
      /max_tokens/,
    );
  });

  it("applies the redaction hook to audited payloads — PII never enters the chain", async () => {
    const runId = "10000000-0000-0000-0000-000000000004";
    await seedSkill("pii-skill@1", {
      fn: async () => ({ contact: "alice@bank.example", account: "12345678901234" }),
    });

    const provider = new MockProvider().queue(
      toolCall(toolNameForRef("pii-skill@1"), { customerEmail: "bob@bank.example" }),
      text("Processed account ending 1234 for alice@bank.example."),
    );

    await makeExecutor(provider, true).execute(stepReq(["pii-skill@1"], {}, runId));

    const events = await auditEvents(runId);
    const serialized = JSON.stringify(events.map((e) => e.payload));
    expect(serialized).not.toContain("alice@bank.example");
    expect(serialized).not.toContain("bob@bank.example");
    expect(serialized).not.toContain("12345678901234");
    expect(serialized).toContain("[REDACTED:email]");
    expect(serialized).toContain("[REDACTED:number]");
  });

  it("throws on an unregistered provider key", async () => {
    await seedSkill("p-skill@1", { fn: async () => ({}) });
    const req = stepReq(["p-skill@1"]);
    req.meta.modelConfig = { provider: "azure-something", model: "x" };
    await expect(makeExecutor(new MockProvider()).execute(req)).rejects.toThrow(
      /no LLM provider registered/,
    );
  });

  // ADVERSARIAL: enforcement filters the permitted skill set ONCE, upstream of
  // the loop; the loop then PINS that set for the whole step (allow-until-step-
  // end). So a grant revoked mid-step — even the running step's own role
  // revoking its grant for a not-yet-called tool — does NOT shrink the pinned
  // set: the second invocation still runs. This is intentional and documented:
  // the loop must not re-enforce grants between tool calls (a step that began
  // authorized completes deterministically; the revocation governs the NEXT
  // run). The guarantee that protects against ungranted execution lives at
  // scheduling + invocation enforcement, not inside the model's tool loop.
  it("pins the permitted tools for the step — a mid-loop grant revoke does not re-enforce", async () => {
    const runId = "10000000-0000-0000-0000-000000000005";

    // Grant both skills to the executor's role. The FIRST skill's fn revokes
    // this very role's grant for the SECOND skill while the step is mid-flight.
    await seedSkill("revoke-self@1", {
      fn: async () => {
        await db.pool.query(
          `UPDATE role_skill_grants SET revoked_at = now()
            WHERE role_id = $1
              AND skill_id = (SELECT id FROM skills WHERE name = 'second-tool' AND version = 1)
              AND revoked_at IS NULL`,
          [META.roleId],
        );
        return { revokedSecondGrant: true };
      },
    });
    await seedSkill("second-tool@1", { fn: async () => ({ ran: true }) });
    await db.pool.query(
      `INSERT INTO role_skill_grants (role_id, skill_id)
       SELECT $1, id FROM skills WHERE name IN ('revoke-self', 'second-tool') AND version = 1`,
      [META.roleId],
    );

    // Two tool calls back to back, then a final text turn. The grant for the
    // second tool is gone by the time it is invoked — but the loop pinned it.
    const provider = new MockProvider().queue(
      toolCall(toolNameForRef("revoke-self@1"), {}, "call_revoke"),
      toolCall(toolNameForRef("second-tool@1"), {}, "call_second"),
      text("Both tools ran."),
    );

    const output = await makeExecutor(provider).execute(
      stepReq(["revoke-self@1", "second-tool@1"], {}, runId),
    );
    // The loop completed normally — the second invocation was NOT re-enforced.
    expect(output).toEqual({ text: "Both tools ran.", iterations: 3 });

    // The grant really is revoked now (so any FUTURE step would be blocked
    // upstream), proving the revoke fired mid-step — yet this step still ran it.
    const activeGrant = await db.pool.query(
      `SELECT 1 FROM role_skill_grants
        WHERE role_id = $1
          AND skill_id = (SELECT id FROM skills WHERE name = 'second-tool' AND version = 1)
          AND revoked_at IS NULL`,
      [META.roleId],
    );
    expect(activeGrant.rowCount).toBe(0);

    // Both skills were invoked and audited; the second produced its real output
    // (not an enforcement error fed back to the model).
    const events = await auditEvents(runId);
    expect(events.map((e) => e.event_type)).toEqual([
      "llm.call",
      "skill.invoked",
      "llm.call",
      "skill.invoked",
      "llm.call",
    ]);
    const invoked = events.filter((e) => e.event_type === "skill.invoked");
    expect(invoked[0]!.payload).toMatchObject({ skillRef: "revoke-self@1" });
    expect(invoked[1]!.payload).toMatchObject({
      skillRef: "second-tool@1",
      output: { ran: true },
    });
  });
});

describe("SkillInvoker — http and mcp dispatch", () => {
  let httpServer: Server;
  let httpUrl: string;

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const { input } = JSON.parse(body) as { input: Record<string, unknown> };
        res.setHeader("content-type", "application/json");
        if (req.url === "/fail") {
          res.statusCode = 500;
          res.end("{}");
        } else {
          res.end(JSON.stringify({ echoed: input, via: "http" }));
        }
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address() as { port: number };
    httpUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    httpServer.close();
  });

  it("invokes an http skill; changing its URL requires a new version (immutability)", async () => {
    await seedSkill("http-skill@1", { implementation: { type: "http", url: "PLACEHOLDER" } });

    // Published skills cannot be edited in place — even by tests.
    await expect(
      db.pool.query(
        `UPDATE skills SET implementation = $1 WHERE name = 'http-skill' AND version = 1`,
        [JSON.stringify({ type: "http", url: `${httpUrl}/ok` })],
      ),
    ).rejects.toThrow(/immutable/);

    // The sanctioned path: publish v2 with the new implementation.
    await db.pool.query(
      `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
       VALUES ('http-skill', 2, '{}', '{}', $1, 'low')`,
      [JSON.stringify({ type: "http", url: `${httpUrl}/ok` })],
    );
    const invoker = new SkillInvoker(db.pool, localRegistry);
    const result = await invoker.invoke(
      "http-skill@2",
      { hello: "world" },
      new AbortController().signal,
    );
    expect(result.output).toEqual({ echoed: { hello: "world" }, via: "http" });
  });

  it("surfaces http failures as execution errors", async () => {
    await db.pool.query(
      `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
       VALUES ('http-fail', 1, '{}', '{}', $1, 'low') ON CONFLICT DO NOTHING`,
      [JSON.stringify({ type: "http", url: `${httpUrl}/fail` })],
    );
    const invoker = new SkillInvoker(db.pool, localRegistry);
    await expect(
      invoker.invoke("http-fail@1", {}, new AbortController().signal),
    ).rejects.toThrow(/returned 500/);
  });

  it("invokes an MCP stdio tool end to end", async () => {
    await db.pool.query(
      `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
       VALUES ('notify', 1, '{}', '{}', $1, 'low') ON CONFLICT DO NOTHING`,
      [
        JSON.stringify({
          type: "mcp",
          transport: "stdio",
          command: process.execPath,
          args: [join(FIXTURES, "mcp-echo-server.mjs")],
          tool: "notify",
        }),
      ],
    );
    const invoker = new SkillInvoker(db.pool, localRegistry);
    try {
      const result = await invoker.invoke(
        "notify@1",
        { channel: "#recon", message: "2 exceptions need review" },
        new AbortController().signal,
      );
      expect(result.output).toEqual({
        delivered: true,
        channel: "#recon",
        message: "2 exceptions need review",
      });
    } finally {
      await invoker.close();
    }
  }, 30_000);

  it("validates output schemas — a lying skill is caught", async () => {
    await seedSkill("liar@1", {
      fn: async () => ({ wrong: "shape" }),
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    });
    const invoker = new SkillInvoker(db.pool, localRegistry);
    await expect(invoker.invoke("liar@1", {}, new AbortController().signal)).rejects.toThrow(
      /output.*failed schema validation/,
    );
  });
});
