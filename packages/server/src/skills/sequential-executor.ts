import type { Pool } from "pg";

import { recordEvent } from "../audit/writer.js";
import type { Json, StepExecutionRequest, StepExecutor } from "../engine/executor.js";
import { checkSkillLimit, LimitViolationError } from "../engine/limits.js";
import { resolveRedactionHook, type RedactionHook } from "../llm/redaction.js";
import type { SkillInvoker } from "./invoker.js";

/**
 * Deterministic, model-free step executor: invokes the step's skills in
 * order through the SkillInvoker (local, http, AND mcp), threading each
 * output into the next input. Used when no LLM API key is configured so the
 * demo runs air-gapped; the LLMExecutor replaces it when a key is present.
 *
 * Same evidentiary duties as the LLM path: every invocation (success OR
 * error) is audited as skill.invoked, and role limits are checked
 * immediately before each one — a violation is audited as
 * enforcement.limit_violation and fails the step.
 *
 * Redaction is part of the write path, mirroring the LLMExecutor: the hook
 * runs over every audit payload (skill input/output included) BEFORE it is
 * hashed into the chain. When no hook is injected it defaults to the
 * deployment-configured one (resolveRedactionHook), so the air-gapped wiring
 * in index.ts honours MAKERCHECKER_REDACTION without an explicit argument
 * rather than silently writing raw secrets.
 */
export class SequentialInvokerExecutor implements StepExecutor {
  private readonly redact: RedactionHook;

  constructor(
    private readonly invoker: SkillInvoker,
    private readonly pool: Pool,
    redact?: RedactionHook,
  ) {
    this.redact = redact ?? resolveRedactionHook();
  }

  async execute(req: StepExecutionRequest): Promise<Json> {
    let current = req.input;
    for (const ref of req.step.skills) {
      if (req.signal.aborted) throw new Error("step aborted");
      try {
        await checkSkillLimit(this.pool, {
          runId: req.meta.runId,
          roleId: req.meta.roleId,
          skillRef: ref,
          input: current,
        });
      } catch (err) {
        if (err instanceof LimitViolationError) {
          await this.audit(req, "enforcement.limit_violation", {
            skillRef: ref,
            code: err.code,
            reason: err.message,
          });
        }
        throw err;
      }
      try {
        const { output } = await this.invoker.invoke(ref, current, req.signal);
        await this.audit(req, "skill.invoked", { skillRef: ref, input: current, output });
        current = output;
      } catch (err) {
        // Failed attempts are audited too — limit counting is conservative.
        await this.audit(req, "skill.invoked", {
          skillRef: ref,
          input: current,
          error: (err as Error).message,
        });
        throw err;
      }
    }
    return current;
  }

  private async audit(
    req: StepExecutionRequest,
    eventType: "skill.invoked" | "enforcement.limit_violation",
    payload: Json,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await recordEvent(client, {
        eventType,
        actor: { type: "agent", id: req.meta.agentId, name: req.meta.agentName },
        entityType: "step_run",
        entityId: req.meta.stepRunId,
        runId: req.meta.runId,
        payload: this.redact({ stepKey: req.step.key, ...payload }),
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
