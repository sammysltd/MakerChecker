import { buildApp } from "./app.js";
import { assertAuthBindSafe } from "./boot/bind-guard.js";
import { createCronTriggerHandler, loadCronItems, TASK_CRON_TRIGGER } from "./boot/cron.js";
import { workerLogger } from "./boot/logger.js";
import { emitRedactionDisabledWarning } from "./boot/redaction-warning.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { demoLocalRegistry } from "./demo/skills.js";
import { seedDemo } from "./demo/seed.js";
import type { StepExecutor } from "./engine/executor.js";
import { SequentialInvokerExecutor } from "./skills/sequential-executor.js";
import { GraphileWorkerBackend, migrateGraphileWorkerSchema } from "./engine/graphile-backend.js";
import { LLMExecutor } from "./engine/llm-executor.js";
import { createHandlers, type EngineContext } from "./engine/orchestrator.js";
import { sweepOverdueApprovals, sweepStuckSteps } from "./engine/watchdog.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { OpenAICompatibleProvider } from "./llm/openai-compatible.js";
import type { LLMProvider } from "./llm/provider.js";
import { resolveRedactionHook } from "./llm/redaction.js";
import { SkillInvoker } from "./skills/invoker.js";

const port = Number(process.env.PORT ?? 3000);
const WATCHDOG_INTERVAL_MS = 60_000;

function buildExecutor(ctx: { pool: EngineContext["pool"] }): { executor: StepExecutor; mode: string } {
  const registry = demoLocalRegistry();
  const providers: Record<string, LLMProvider> = {};
  let defaultProvider: string | null = null;
  let defaultModel: string | null = null;

  if (process.env.ANTHROPIC_API_KEY) {
    providers.anthropic = new AnthropicProvider({});
    defaultProvider = "anthropic";
    defaultModel = process.env.MAKERCHECKER_MODEL ?? "claude-opus-4-8";
  } else if (process.env.GEMINI_API_KEY) {
    providers.gemini = new OpenAICompatibleProvider({
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: process.env.GEMINI_API_KEY,
    });
    defaultProvider = "gemini";
    defaultModel = process.env.MAKERCHECKER_MODEL ?? "gemini-3-flash-preview";
  }

  if (defaultProvider && process.env.MAKERCHECKER_EXECUTOR !== "scripted") {
    return {
      executor: new LLMExecutor({
        pool: ctx.pool,
        providers,
        invoker: new SkillInvoker(ctx.pool, registry),
        redact: resolveRedactionHook(),
        defaultProvider,
        defaultModel: defaultModel!,
      }),
      mode: `llm (${defaultProvider})`,
    };
  }
  // No API key: deterministic scripted execution so the demo works air-gapped.
  return {
    executor: new SequentialInvokerExecutor(new SkillInvoker(ctx.pool, registry), ctx.pool),
    mode: "scripted",
  };
}

async function main(): Promise<void> {
  const pool = createPool();
  // Migrations run at boot by default (the single-role docker/quickstart flow,
  // where the server connects as the table owner). The hardened two-role
  // deployment (ops/harden-db.sql) connects as the non-owner mc_app_runtime,
  // which lacks CREATE on the public schema and so cannot run migrate(); there a
  // separate owner-credentialed migrate step applies migrations first and this
  // boot step is skipped with MAKERCHECKER_SKIP_MIGRATE=1. Default unset = run.
  if (process.env.MAKERCHECKER_SKIP_MIGRATE !== "1") {
    await migrate(pool);
    // Install the worker queue schema as the owner; the runtime role cannot.
    await migrateGraphileWorkerSchema(pool);
  }
  // Demo seeding is opt-IN: it provisions an admin account, prints an admin API
  // key, and registers the demo local skills (which read from DEMO_DATA_DIR).
  // A default production image must never do that, so seed only when asked.
  if (process.env.MAKERCHECKER_SEED_DEMO === "1") {
    await seedDemo(pool);
  }

  const backend = new GraphileWorkerBackend(pool);
  const { executor, mode } = buildExecutor({ pool });
  const ctx: EngineContext = { pool, backend, executor };
  const cronItems = await loadCronItems(pool);
  await backend.start(
    { ...createHandlers(ctx), [TASK_CRON_TRIGGER]: createCronTriggerHandler(ctx) },
    cronItems.length > 0 ? { parsedCronItems: cronItems } : {},
  );
  if (cronItems.length > 0) {
    workerLogger.info({ cronTriggers: cronItems.length }, "cron triggers scheduled");
  }

  // Watchdog: recover steps orphaned by crashed workers and flag approvals
  // pending past the overdue threshold. A sweep failure is logged, never
  // fatal — the next tick tries again.
  setInterval(() => {
    void sweepStuckSteps(ctx).catch((err: Error) =>
      workerLogger.error({ err: { message: err.message } }, "watchdog: stuck-step sweep failed"),
    );
    void sweepOverdueApprovals(ctx).catch((err: Error) =>
      workerLogger.error(
        { err: { message: err.message } },
        "watchdog: overdue-approval sweep failed",
      ),
    );
  }, WATCHDOG_INTERVAL_MS).unref();

  const app = await buildApp(ctx);
  const host = "0.0.0.0";
  assertAuthBindSafe(host, process.env.MAKERCHECKER_AUTH_DISABLED === "1");
  await app.listen({ port, host });
  workerLogger.info({ port, host, executor: mode }, "makerchecker server listening");
  await emitRedactionDisabledWarning(pool, workerLogger);
}

main().catch((err: Error) => {
  workerLogger.fatal({ err: { message: err.message, stack: err.stack } }, "fatal boot error");
  process.exit(1);
});
