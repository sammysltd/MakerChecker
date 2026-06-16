import type { AgentStepDef } from "@makerchecker/shared";

export type Json = Record<string, unknown>;

export interface StepExecutionMeta {
  runId: string;
  stepRunId: string;
  agentId: string;
  agentName: string;
  /** The agent's role frozen at scheduling time; limits are evaluated against it. */
  roleId: string;
  modelConfig: Json;
}

export interface StepExecutionRequest {
  step: AgentStepDef;
  input: Json;
  signal: AbortSignal;
  meta: StepExecutionMeta;
}

/**
 * Executes one agent step. LocalSkillExecutor runs skills as plain functions
 * (used in tests and the deterministic demo); the LLM tool-use loop +
 * SkillInvoker is the production executor.
 */
export interface StepExecutor {
  execute(req: StepExecutionRequest): Promise<Json>;
}

export type LocalSkillFn = (input: Json, signal: AbortSignal) => Promise<Json>;

/** Invokes the step's skills in order; each receives the previous output. */
export class LocalSkillExecutor implements StepExecutor {
  constructor(private readonly registry: Map<string, LocalSkillFn>) {}

  async execute(req: StepExecutionRequest): Promise<Json> {
    let current = req.input;
    for (const ref of req.step.skills) {
      const fn = this.registry.get(ref);
      if (!fn) throw new Error(`no local implementation registered for skill "${ref}"`);
      if (req.signal.aborted) throw new Error("step aborted");
      current = await fn(current, req.signal);
    }
    return current;
  }
}
