import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../../test/test-db.js";
import { notifyWebhooks, webhookFailureCount } from "./dispatcher.js";

/**
 * Delivery retry behaviour (M14). Backoffs are injected (a few ms) so the
 * suite proves the retry LOGIC, not the production waits. The engine-path
 * guarantee — dead and permanently-failing endpoints never block or fail a
 * run — is proven in webhooks.integration.test.ts against a live engine.
 */

const FAST = { backoffMs: [5, 5, 5] };

let db: TestDb;
let flaky: Server;
let flakyUrl: string;
let deadUrl: string;

/** Counts every POST; 500s until `failuresLeft` runs out, then 204s. */
let failuresLeft = 0;
let posts = 0;
let successes = 0;
const PREV_ALLOW_PRIVATE = process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function setEndpoints(urls: string[]): Promise<void> {
  await db.pool.query("DELETE FROM webhook_endpoints");
  for (const url of urls) {
    await db.pool.query(
      "INSERT INTO webhook_endpoints (url, secret, enabled) VALUES ($1, 's', true)",
      [url],
    );
  }
}

beforeAll(async () => {
  // These endpoints listen on 127.0.0.1; opt the dispatcher's SSRF egress guard
  // in for the test process only (production never sets this).
  process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = "1";
  db = await createTestDb();

  flaky = createServer((_req, res) => {
    posts += 1;
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      res.writeHead(500).end();
      return;
    }
    successes += 1;
    res.writeHead(204).end();
  });
  flakyUrl = await listen(flaky);

  const ghost = createServer(() => {});
  deadUrl = await listen(ghost);
  await new Promise((resolve) => ghost.close(resolve));
}, 60_000);

afterAll(async () => {
  await new Promise((resolve) => flaky.close(resolve));
  await db.drop();
  if (PREV_ALLOW_PRIVATE === undefined) delete process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;
  else process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = PREV_ALLOW_PRIVATE;
});

describe("webhook delivery retries", () => {
  it("an endpoint failing twice then succeeding gets exactly 3 posts and ONE delivery", async () => {
    await setEndpoints([flakyUrl]);
    posts = 0;
    successes = 0;
    failuresLeft = 2;
    const failedBefore = webhookFailureCount();

    await notifyWebhooks(db.pool, "retry.flaky", { runId: "run-1", data: { n: 1 } }, FAST);

    expect(posts).toBe(3);
    expect(successes).toBe(1);
    // A delivery that eventually lands is not a failure.
    expect(webhookFailureCount()).toBe(failedBefore);
  });

  it("a first-attempt success never retries", async () => {
    posts = 0;
    successes = 0;
    failuresLeft = 0;

    await notifyWebhooks(db.pool, "retry.healthy", { runId: "run-2", data: {} }, FAST);

    expect(posts).toBe(1);
    expect(successes).toBe(1);
  });

  it("an endpoint that always 500s exhausts 3 attempts and bumps the failure counter", async () => {
    posts = 0;
    failuresLeft = Number.MAX_SAFE_INTEGER;
    const failedBefore = webhookFailureCount();

    await expect(
      notifyWebhooks(db.pool, "retry.permafail", { runId: "run-3", data: {} }, FAST),
    ).resolves.toBeUndefined();

    expect(posts).toBe(3);
    expect(webhookFailureCount()).toBe(failedBefore + 1);
    failuresLeft = 0;
  });

  it("a permanently-down endpoint (connection refused) never throws and is counted once", async () => {
    await setEndpoints([deadUrl]);
    const failedBefore = webhookFailureCount();

    await expect(
      notifyWebhooks(db.pool, "retry.dead", { runId: "run-4", data: {} }, FAST),
    ).resolves.toBeUndefined();

    expect(webhookFailureCount()).toBe(failedBefore + 1);
  });

  it("one broken endpoint does not stop delivery to a healthy one", async () => {
    await setEndpoints([deadUrl, flakyUrl]);
    posts = 0;
    successes = 0;
    failuresLeft = 0;
    const failedBefore = webhookFailureCount();

    await notifyWebhooks(db.pool, "retry.mixed", { runId: "run-5", data: {} }, FAST);

    expect(successes).toBe(1); // healthy endpoint delivered
    expect(webhookFailureCount()).toBe(failedBefore + 1); // dead endpoint counted
  });
});
