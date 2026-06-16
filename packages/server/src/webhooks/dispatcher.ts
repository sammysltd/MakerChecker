import { createHmac } from "node:crypto";

import type { Pool } from "pg";

import { resolveRedactionHook } from "../llm/redaction.js";
import { assertSafeHttpUrl } from "../skills/invoker.js";
import { createPinnedFetch, SsrfBlockedError } from "../skills/ssrf-guard.js";

/**
 * Outbound webhook delivery. Fire-and-forget: deliveries are signed
 * notifications dispatched AFTER the owning transaction commits; a slow or
 * dead endpoint must never block or fail the engine. The audit chain stays
 * the canonical record; webhooks are fire-and-forget notifications layered on
 * top of it.
 *
 * Each delivery is retried up to MAX_ATTEMPTS times with backoff; a delivery
 * that exhausts every attempt is logged and counted (see
 * webhookFailureCount, surfaced as makerchecker_webhook_failures_total on
 * /metrics) but never thrown into the engine.
 */

const DELIVERY_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [250, 1_000, 4_000];

/** Process-lifetime count of deliveries that exhausted every retry attempt. */
let failedDeliveries = 0;

/**
 * Lazily-created connect-time-pinned fetch (see ssrf-guard.ts). Its undici Agent
 * resolves each webhook host once, rejects any private/loopback/link-local
 * address, and pins the TCP connection to the validated address — so a webhook
 * URL whose hostname rebinds to an internal IP at connect time is refused even
 * though it passed the static assertSafeHttpUrl check. One Agent for the whole
 * process (webhook delivery is high-frequency; a fresh Agent per delivery would
 * leak sockets). FULLY PINNED path.
 */
let pinned: ReturnType<typeof createPinnedFetch> | undefined;
function pinnedFetch(): ReturnType<typeof createPinnedFetch>["fetch"] {
  pinned ??= createPinnedFetch();
  return pinned.fetch;
}

export function webhookFailureCount(): number {
  return failedDeliveries;
}

export interface PendingWebhook {
  event: string;
  runId: string;
  data: Record<string, unknown>;
}

/** Injectable for fast tests; production callers use the defaults. */
export interface DispatchOptions {
  /** Waits between attempts: backoffMs[0] after attempt 1, [1] after 2, ... */
  backoffMs?: number[];
}

/** HMAC-SHA256 of the raw body, formatted for the x-makerchecker-signature header. */
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True if `err` is (or wraps via undici's fetch `cause`) an SsrfBlockedError —
 * the connect-time pin refused a private/loopback/link-local target. undici
 * surfaces a connector-hook rejection as TypeError("fetch failed") with our
 * SsrfBlockedError as `.cause`, so unwrap one level.
 */
function isWebhookSsrfBlocked(err: unknown): boolean {
  if (err instanceof SsrfBlockedError) return true;
  return (err as { cause?: unknown })?.cause instanceof SsrfBlockedError;
}

/** Best message for a (possibly wrapped) error, for the failure log line. */
function extractCauseMessage(err: unknown): string {
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof Error) return cause.message;
  return (err as Error).message;
}

/**
 * Posts one body to one endpoint, retrying with backoff. Never throws;
 * exhausting every attempt logs the final failure and bumps the counter.
 */
async function deliverWithRetry(
  endpoint: { url: string; secret: string },
  event: string,
  body: string,
  backoffMs: number[],
): Promise<void> {
  // SSRF egress guard (static): endpoint URLs are operator-stored but still
  // untrusted at dispatch time. Reject literal private/loopback/link-local IPs +
  // metadata hostnames up front (with the MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS=1
  // dev/test opt-in). A statically-blocked URL is never POSTed.
  try {
    assertSafeHttpUrl(endpoint.url);
  } catch (err) {
    failedDeliveries += 1;
    console.error(
      `webhooks: delivery to ${endpoint.url} blocked by SSRF guard ` +
        `for ${event}: ${(err as Error).message}`,
    );
    return;
  }

  let lastError = "unknown";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // FULLY PINNED: pinnedFetch resolves the host through the undici Agent's
      // connect hook, rejects any private/loopback/link-local address, and pins
      // the connection to the validated address — defeating a hostname that
      // rebinds to an internal IP at connect time (the static check above only
      // sees literals). A rebinding rejection surfaces as the fetch failure's
      // `cause`; treat it as a hard block (no retry) and stop.
      const res = await pinnedFetch()(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-makerchecker-signature": signWebhookBody(endpoint.secret, body),
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (res.ok) return;
      lastError = `endpoint responded ${res.status}`;
    } catch (err) {
      if (isWebhookSsrfBlocked(err)) {
        failedDeliveries += 1;
        console.error(
          `webhooks: delivery to ${endpoint.url} blocked by connect-time SSRF ` +
            `pin (DNS rebinding) for ${event}: ${extractCauseMessage(err)}`,
        );
        return;
      }
      lastError = (err as Error).message;
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(backoffMs[attempt - 1] ?? backoffMs.at(-1) ?? 0);
    }
  }
  failedDeliveries += 1;
  console.error(
    `webhooks: delivery to ${endpoint.url} failed after ${MAX_ATTEMPTS} attempts ` +
      `for ${event}: ${lastError}`,
  );
}

/**
 * Delivers one event to every enabled endpoint. Never throws; failures are
 * retried, then logged and counted, and otherwise swallowed.
 */
export async function notifyWebhooks(
  pool: Pool,
  event: string,
  payload: { runId: string; data: Record<string, unknown> },
  options?: DispatchOptions,
): Promise<void> {
  let endpoints: Array<{ url: string; secret: string }>;
  try {
    const res = await pool.query<{ url: string; secret: string }>(
      "SELECT url, secret FROM webhook_endpoints WHERE enabled",
    );
    endpoints = res.rows;
  } catch (err) {
    console.error(`webhooks: failed to load endpoints: ${(err as Error).message}`);
    return;
  }
  if (endpoints.length === 0) return;

  // Webhooks are an egress seam: the event `data` can carry skill/caller text
  // (e.g. a run.failed reason built from a raw skill error). Apply the configured
  // redaction hook here, centrally, so EVERY outbound event is masked the same
  // way the audit chain, API reads, and evidence pack are — secrets must not
  // leave the system in cleartext just because they leave via a webhook.
  const body = JSON.stringify({
    event,
    runId: payload.runId,
    data: resolveRedactionHook()(payload.data),
    occurredAt: new Date().toISOString(),
  });
  const backoffMs = options?.backoffMs ?? DEFAULT_BACKOFF_MS;

  await Promise.all(
    endpoints.map((endpoint) => deliverWithRetry(endpoint, event, body, backoffMs)),
  );
}

/**
 * Fires collected notifications without awaiting them. Call ONLY after the
 * transaction that produced the state change has committed.
 */
export function firePendingWebhooks(
  pool: Pool,
  pending: PendingWebhook[],
  options?: DispatchOptions,
): void {
  for (const p of pending) {
    void notifyWebhooks(pool, p.event, { runId: p.runId, data: p.data }, options);
  }
}

/**
 * Test-only seam: exercise the per-endpoint delivery (incl. the connect-time
 * SSRF pin) directly, without standing up a flow/run. Not part of the public
 * surface — used by dispatcher.rebinding.test.ts to drive the rebinding case.
 */
export function deliverWithRetryForTest(
  endpoint: { url: string; secret: string },
  event: string,
  body: string,
  backoffMs: number[],
): Promise<void> {
  return deliverWithRetry(endpoint, event, body, backoffMs);
}
