import type { Pool } from "pg";

import { recordEvent } from "../audit/writer.js";
import type {
  AssistantBlock,
  LLMMessage,
  LLMProvider,
  ToolDef,
} from "../llm/provider.js";
import { noRedaction, type RedactionHook } from "../llm/redaction.js";
import { SkillInvocationError, type SkillInvoker } from "../skills/invoker.js";
import type { Json, StepExecutionRequest, StepExecutor } from "./executor.js";
import { checkSkillLimit, checkTokenBudget, LimitViolationError } from "./limits.js";

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_TOKENS = 16_000;
const DEFAULT_MODEL = "claude-opus-4-8";

export interface LLMExecutorOptions {
  pool: Pool;
  providers: Record<string, LLMProvider>; // keyed by model_config.provider
  invoker: SkillInvoker;
  redact?: RedactionHook;
  maxIterations?: number;
  /** Used when an agent's model_config omits provider/model. */
  defaultProvider?: string;
  defaultModel?: string;
}

/** Tool names must match ^[a-zA-Z0-9_-]+$; skill refs contain "@". */
export function toolNameForRef(ref: string): string {
  return ref.replace("@", "__v");
}

/**
 * The real agent step executor: a bounded tool-use loop where the tools
 * presented to the model are EXACTLY the step's permitted skills (already
 * enforcement-filtered upstream). Every model call and every skill invocation
 * is audited — after the redaction hook — as llm.call / skill.invoked.
 */
export class LLMExecutor implements StepExecutor {
  private readonly redact: RedactionHook;
  private readonly maxIterations: number;

  constructor(private readonly options: LLMExecutorOptions) {
    this.redact = options.redact ?? noRedaction;
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  }

  async execute(req: StepExecutionRequest): Promise<Json> {
    const provider = this.resolveProvider(req.meta.modelConfig);
    const model = String(
      req.meta.modelConfig.model ?? this.options.defaultModel ?? DEFAULT_MODEL,
    );
    const maxTokens = Number(req.meta.modelConfig.maxTokens ?? DEFAULT_MAX_TOKENS);

    const { tools, refByToolName } = await this.buildTools(req.step.skills);
    const system = this.systemPrompt(req);
    const messages: LLMMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `${req.step.instructions ?? "Complete this step."}\n\n` +
              `Step input:\n${JSON.stringify(req.input, null, 2)}`,
          },
        ],
      },
    ];

    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
      // Token budget is checked BEFORE each provider call: an exhausted
      // budget fails the step without spending another model invocation.
      await this.checkLimit(req, () =>
        checkTokenBudget(this.options.pool, {
          runId: req.meta.runId,
          roleId: req.meta.roleId,
        }),
      );

      const turn = await provider.complete({
        model,
        system,
        messages,
        tools,
        maxTokens,
        signal: req.signal,
      });

      await this.audit(req, "llm.call", {
        iteration,
        model,
        system,
        request: { messages: messages as unknown as Json[] },
        response: { stopReason: turn.stopReason, content: turn.content as unknown as Json[] },
        usage: turn.usage,
      });

      if (turn.stopReason === "refusal") {
        throw new Error("model refused the request");
      }
      if (turn.stopReason === "max_tokens") {
        throw new Error("model response truncated at max_tokens");
      }

      const toolUses = turn.content.filter(
        (b): b is Extract<AssistantBlock, { type: "tool_use" }> => b.type === "tool_use",
      );
      if (turn.stopReason !== "tool_use" || toolUses.length === 0) {
        const text = turn.content
          .filter((b): b is Extract<AssistantBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        return { text, iterations: iteration };
      }

      messages.push({ role: "assistant", content: turn.content });
      const results: LLMMessage["content"] = [];
      for (const call of toolUses) {
        results.push(await this.invokeTool(req, refByToolName, call));
      }
      messages.push({ role: "user", content: results });
    }

    throw new Error(`tool-use loop exceeded ${this.maxIterations} iterations`);
  }

  private async invokeTool(
    req: StepExecutionRequest,
    refByToolName: Map<string, string>,
    call: Extract<AssistantBlock, { type: "tool_use" }>,
  ): Promise<LLMMessage["content"][number]> {
    const ref = refByToolName.get(call.name);
    if (!ref) {
      // The model hallucinated a tool. Feed the error back so it can recover;
      // it can never invoke anything outside the permitted set.
      await this.audit(req, "skill.invoked", {
        toolName: call.name,
        error: "unknown tool: not in this step's permitted skills",
      });
      return {
        type: "tool_result",
        toolUseId: call.id,
        content: `Error: "${call.name}" is not an available tool for this step.`,
        isError: true,
      };
    }

    // Role limits, checked immediately before the invocation. A violation
    // FAILS THE STEP — it throws out of execute() and is never fed back to
    // the model, which must not get to negotiate with an enforcement result.
    await this.checkLimit(req, () =>
      checkSkillLimit(this.options.pool, {
        runId: req.meta.runId,
        roleId: req.meta.roleId,
        skillRef: ref,
        input: call.input,
      }),
    );

    try {
      const { output } = await this.options.invoker.invoke(ref, call.input, req.signal);
      await this.audit(req, "skill.invoked", { skillRef: ref, input: call.input, output });
      return { type: "tool_result", toolUseId: call.id, content: JSON.stringify(output) };
    } catch (err) {
      const message =
        err instanceof SkillInvocationError ? `${err.code}: ${err.message}` : (err as Error).message;
      await this.audit(req, "skill.invoked", {
        skillRef: ref,
        input: call.input,
        error: message,
      });
      return { type: "tool_result", toolUseId: call.id, content: `Error: ${message}`, isError: true };
    }
  }

  private async buildTools(
    skillRefs: string[],
  ): Promise<{ tools: ToolDef[]; refByToolName: Map<string, string> }> {
    const tools: ToolDef[] = [];
    const refByToolName = new Map<string, string>();
    for (const ref of skillRefs) {
      const skill = await this.options.invoker.loadSkill(ref);
      const toolName = toolNameForRef(ref);
      refByToolName.set(toolName, ref);
      tools.push({
        name: toolName,
        description: skill.description || `Skill ${ref}`,
        inputSchema: normalizeSchema(skill.input_schema),
      });
    }
    return { tools, refByToolName };
  }

  private systemPrompt(req: StepExecutionRequest): string {
    return (
      `You are "${req.meta.agentName}", an agent operating inside MakerChecker, ` +
      `a governed execution environment. You are executing the step "${req.step.key}" of a flow run. ` +
      `You may ONLY act through the tools provided; every action is audited. ` +
      `Use the tools to complete the step, then reply with a concise summary of what you did and the result. ` +
      `If the task cannot be completed with the available tools, say so plainly instead of guessing.`
    );
  }

  private resolveProvider(modelConfig: Json): LLMProvider {
    const key = String(modelConfig.provider ?? this.options.defaultProvider ?? "anthropic");
    const provider = this.options.providers[key];
    if (!provider) {
      throw new Error(`no LLM provider registered for "${key}"`);
    }
    return provider;
  }

  /** Runs a limit check; violations are audited, then thrown to fail the step. */
  private async checkLimit(req: StepExecutionRequest, check: () => Promise<void>): Promise<void> {
    try {
      await check();
    } catch (err) {
      if (err instanceof LimitViolationError) {
        await this.audit(req, "enforcement.limit_violation", {
          code: err.code,
          reason: err.message,
        });
      }
      throw err;
    }
  }

  private async audit(
    req: StepExecutionRequest,
    eventType: "llm.call" | "skill.invoked" | "enforcement.limit_violation",
    payload: Json,
  ): Promise<void> {
    const client = await this.options.pool.connect();
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

/** Ensures the schema is at least a valid object schema for tool definitions. */
function normalizeSchema(schema: Json): Json {
  if (!schema || Object.keys(schema).length === 0) {
    return { type: "object" };
  }
  return schema;
}
