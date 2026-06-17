import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { GraphileWorkerBackend, migrateGraphileWorkerSchema } from "./graphile-backend.js";
import { LLMExecutor } from "./llm-executor.js";
import { publishFlowVersion } from "./flows.js";
import { advanceRun, executeStep, startRun, type EngineContext } from "./orchestrator.js";
import type { LLMProvider, LLMRequest, LLMTurn } from "../llm/provider.js";
import { SkillInvoker } from "../skills/invoker.js";

/**
 * Red-team regression suite for the LIVE MODEL_CONFIG FAIL-OPEN defect: the
 * agent's model_config was read LIVE from the agents table at execution, so an
 * admin editing agents.model_config between scheduling and execution silently
 * swapped which model ran an already-scheduled step. The as-run model must be
 * the as-approved one: model_config is FROZEN at scheduling
 * (step_runs.model_config_snapshot) and the executor reads the frozen copy.
 *
 * The resolved model is observable in the llm.call audit payload's `model`
 * field, which is what these tests assert on. A null snapshot (a step_run
 * scheduled before the migration) must fall back to live model_config.
 */

let db: TestDb;
let ctx: EngineContext;
let provider: RecordingProvider;
const USER = { type: "user" as const, id: "mc-user", name: "Model Config Tester" };

beforeAll(async () => {
  db = await createTestDb();
  // Install the graphile-worker schema (enqueueInTx writes to it) but never
  // start a worker: these tests drive advanceRun / executeStep BY HAND so the
  // mid-run edit to agents.model_config lands in the gap between scheduling
  // (the freeze) and execution (the read). A running worker would race that gap.
  await migrateGraphileWorkerSchema(db.pool);
  const backend = new GraphileWorkerBackend(db.pool, 5);
  provider = new RecordingProvider();
  const executor = new LLMExecutor({
    pool: db.pool,
    providers: { anthropic: provider },
    invoker: new SkillInvoker(db.pool, new Map()),
  });
  ctx = { pool: db.pool, backend, executor };
}, 60_000);

afterAll(async () => {
  await db.drop();
});

/** Scripted provider: returns a single end_turn and records every request. */
class RecordingProvider implements LLMProvider {
  requests: LLMRequest[] = [];

  async complete(req: LLMRequest): Promise<LLMTurn> {
    this.requests.push(req);
    return {
      stopReason: "end_turn",
      content: [{ type: "text", text: "done" }],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

async function seedAgent(name: string, model: string): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `WITH role AS (INSERT INTO roles (name) VALUES ($1) RETURNING id)
     INSERT INTO agents (name, role_id, model_config)
     SELECT $2, id, $3 FROM role RETURNING id`,
    [`${name}-role`, name, JSON.stringify({ provider: "anthropic", model })],
  );
  return rows[0]!.id;
}

/** A granted skill so enforcement passes; the model ends without calling it. */
async function seedGrantedSkill(agentName: string, ref: string): Promise<void> {
  const [name, version] = ref.split("@");
  await db.pool.query(
    `INSERT INTO skills (name, version, input_schema, output_schema, implementation, risk_tier)
     VALUES ($1, $2, '{}', '{}', '{"type":"local"}', 'low') ON CONFLICT DO NOTHING`,
    [name, Number(version)],
  );
  await db.pool.query(
    `INSERT INTO role_skill_grants (role_id, skill_id)
     SELECT a.role_id, s.id FROM agents a, skills s
      WHERE a.name = $1 AND s.name = $2 AND s.version = $3`,
    [agentName, name, Number(version)],
  );
}

async function setLiveModelConfig(agentId: string, model: string): Promise<void> {
  await db.pool.query("UPDATE agents SET model_config = $2 WHERE id = $1", [
    agentId,
    JSON.stringify({ provider: "anthropic", model }),
  ]);
}

/** A one-step LLM flow whose model ends the turn without calling the skill. */
async function publishSingleStep(
  flowName: string,
  agentName: string,
  skillRef: string,
): Promise<string> {
  const { flowVersionId } = await publishFlowVersion(db.pool, {
    actor: USER,
    definition: {
      name: flowName,
      steps: [{ key: "s", agent: agentName, skills: [skillRef], instructions: "Work." }],
    },
  });
  return flowVersionId;
}

async function pendingStepRunId(runId: string): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    "SELECT id FROM step_runs WHERE run_id = $1 ORDER BY id DESC LIMIT 1",
    [runId],
  );
  return rows[0]!.id;
}

async function llmCallModels(runId: string): Promise<string[]> {
  const { rows } = await db.pool.query<{ payload: { model: string } }>(
    "SELECT payload FROM audit_events WHERE run_id = $1 AND event_type = 'llm.call' ORDER BY seq",
    [runId],
  );
  return rows.map((r) => r.payload.model);
}

describe("model_config is frozen at scheduling, not read live at execution", () => {
  it("editing agents.model_config between scheduling and execution does NOT change the model", async () => {
    const agentId = await seedAgent("freeze-agent", "claude-opus-4-8");
    await seedGrantedSkill("freeze-agent", "noop@1");
    const flowVersionId = await publishSingleStep("freeze-flow", "freeze-agent", "noop@1");

    // startRun enqueues the first advance, but we drive advanceRun ourselves so
    // the step is scheduled (and its model_config frozen) right here.
    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    await advanceRun(ctx, runId);
    const stepRunId = await pendingStepRunId(runId);

    // The frozen copy was taken at scheduling; the live row is now wide open.
    const frozen = await db.pool.query<{ model_config_snapshot: { model: string } }>(
      "SELECT model_config_snapshot FROM step_runs WHERE id = $1",
      [stepRunId],
    );
    expect(frozen.rows[0]!.model_config_snapshot.model).toBe("claude-opus-4-8");

    // Admin swaps the live model AFTER scheduling, BEFORE execution.
    await setLiveModelConfig(agentId, "attacker-model");

    await executeStep(ctx, stepRunId);

    // The as-run model is the frozen one, never the live "attacker-model".
    expect(await llmCallModels(runId)).toEqual(["claude-opus-4-8"]);
    const live = await db.pool.query<{ model_config: { model: string } }>(
      "SELECT model_config FROM agents WHERE id = $1",
      [agentId],
    );
    expect(live.rows[0]!.model_config.model).toBe("attacker-model");
  });

  it("a RETRY re-uses the frozen model, not the model changed between attempts", async () => {
    const agentId = await seedAgent("retry-model-agent", "claude-opus-4-8");
    await seedGrantedSkill("retry-model-agent", "noop@1");
    const { flowVersionId } = await publishFlowVersion(db.pool, {
      actor: USER,
      definition: {
        name: "retry-model-flow",
        steps: [
          {
            key: "s",
            agent: "retry-model-agent",
            skills: ["noop@1"],
            instructions: "Work.",
            retries: { max_attempts: 2, backoff: "none" },
          },
        ],
      },
    });

    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER });
    // Attempt 1 schedules and freezes opus.
    await advanceRun(ctx, runId);
    const attempt1 = await pendingStepRunId(runId);
    // Admin swaps the live model; then attempt 1 fails to force a retry.
    await setLiveModelConfig(agentId, "attacker-model");
    await db.pool.query(
      "UPDATE step_runs SET status = 'failed', finished_at = now() WHERE id = $1",
      [attempt1],
    );
    // Attempt 2 schedules: it must carry attempt 1's frozen model, not the live one.
    await advanceRun(ctx, runId);

    const snaps = await db.pool.query<{ model_config_snapshot: { model: string } }>(
      "SELECT model_config_snapshot FROM step_runs WHERE run_id = $1 ORDER BY attempt",
      [runId],
    );
    expect(snaps.rows.length).toBe(2);
    for (const row of snaps.rows) {
      expect(row.model_config_snapshot.model).toBe("claude-opus-4-8");
    }
  });

  it("a null snapshot (pre-migration row) falls back to live model_config", async () => {
    const agentId = await seedAgent("fallback-agent", "claude-opus-4-8");
    await seedGrantedSkill("fallback-agent", "noop@1");
    const flowVersionId = await publishSingleStep("fallback-flow", "fallback-agent", "noop@1");
    const runId = await startRun(ctx, { flowVersionId, triggeredBy: USER });

    // Insert a step_run by hand WITHOUT a model_config_snapshot (genuinely NULL,
    // not '{}'), exactly as a row scheduled before migration 0008 would look.
    const inserted = await db.pool.query<{ id: string }>(
      `INSERT INTO step_runs
         (run_id, step_index, step_key, agent_id, role_id_snapshot, status, attempt, input, started_at)
       SELECT $1, 0, 's', $2, a.role_id, 'running', 1, '{}', now()
         FROM agents a WHERE a.id = $2 RETURNING id`,
      [runId, agentId],
    );
    await db.pool.query("UPDATE flow_runs SET status = 'running' WHERE id = $1", [runId]);

    // The live row is the only source for a null snapshot — set it to a known model.
    await setLiveModelConfig(agentId, "live-fallback-model");
    await executeStep(ctx, inserted.rows[0]!.id);

    expect(await llmCallModels(runId)).toEqual(["live-fallback-model"]);
  });
});
