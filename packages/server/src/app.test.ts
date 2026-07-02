import { randomBytes } from "node:crypto";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loggerOptions } from "./boot/logger.js";
import { beginShutdown, resetShutdownState } from "./boot/lifecycle.js";
import type { EngineContext } from "./engine/orchestrator.js";

/**
 * Builds an app whose Fastify logger writes JSON to a captured buffer at info
 * level (the suite default is silent), so a test can read the access line and
 * the error log. Each captured line is one parsed pino record.
 */
async function buildAppWithCapturedLog(
  ctx?: EngineContext,
): Promise<{ app: Awaited<ReturnType<typeof buildApp>>; lines: () => Record<string, unknown>[] }> {
  const chunks: string[] = [];
  const stream = { write: (s: string) => chunks.push(s) };
  const logger = pino(loggerOptions("info"), stream as never);
  const app = await buildApp(ctx, { loggerInstance: logger });
  return {
    app,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe("GET /healthz", () => {
  it("returns ok with the schema version", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", schemaVersion: 1 });
    await app.close();
  });

  it("404s unknown routes", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /readyz", () => {
  const okCtx = {
    pool: { query: async () => ({ rows: [{ "?column?": 1 }] }) },
  } as unknown as EngineContext;

  afterEach(() => {
    resetShutdownState();
  });

  it("returns 200 with the schema version when ready and the DB answers", async () => {
    const app = await buildApp(okCtx);
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", schemaVersion: 1 });
    await app.close();
  });

  it("returns 503 while shutting down, before pinging the DB", async () => {
    const queried = { hit: false };
    const drainingCtx = {
      pool: {
        query: async () => {
          queried.hit = true;
          return { rows: [] };
        },
      },
    } as unknown as EngineContext;
    const app = await buildApp(drainingCtx);
    beginShutdown();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "shutting_down" });
    expect(queried.hit).toBe(false);
    await app.close();
  });

  it("returns 503 when the DB ping throws", async () => {
    const downCtx = {
      pool: {
        query: async () => {
          throw new Error("connect ECONNREFUSED 10.0.3.5:5432");
        },
      },
    } as unknown as EngineContext;
    const app = await buildApp(downCtx);
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "db_unreachable" });
    // The infra detail in the thrown error never reaches the client body.
    expect(res.body).not.toContain("ECONNREFUSED");
    await app.close();
  });

  it("stays open under the /api auth hook (no key required)", async () => {
    const app = await buildApp(okCtx);
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("security hardening", () => {
  // A stub pool whose query resolves a published flow row, so /flows/:name/runs
  // reaches body validation without a real database. connect() backs the
  // orchestrator's transaction; it is never needed before validation fails.
  const stubCtx = {
    pool: { query: async () => ({ rows: [{ id: "11111111-1111-1111-1111-111111111111" }] }) },
  } as unknown as EngineContext;

  describe("helmet security headers", () => {
    it("sets the CSP and core hardening headers on responses", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      const csp = res.headers["content-security-policy"];
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("img-src 'self' data:");
      // helmet's other defenses ride along.
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
      await app.close();
    });
  });

  describe("CORS", () => {
    afterEach(() => {
      delete process.env.ALLOWED_ORIGINS;
    });

    it("denies a cross-origin request by default (no allow-origin header)", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: { origin: "https://evil.example.com" },
      });
      // origin:false means the browser-blocking outcome: the response carries
      // no Access-Control-Allow-Origin, so a cross-origin reader is denied.
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      await app.close();
    });

    it("reflects an explicitly allow-listed origin", async () => {
      process.env.ALLOWED_ORIGINS = "https://app.example.com, https://admin.example.com";
      const app = await buildApp();
      const ok = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: { origin: "https://app.example.com" },
      });
      expect(ok.headers["access-control-allow-origin"]).toBe("https://app.example.com");
      // An origin not on the list still gets no allow-origin header.
      const denied = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: { origin: "https://evil.example.com" },
      });
      expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
      await app.close();
    });
  });

  describe("body schema validation", () => {
    afterEach(() => {
      delete process.env.MAKERCHECKER_AUTH_DISABLED;
    });

    it("rejects an unknown top-level key on POST /flows/:name/runs with 400", async () => {
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
      const app = await buildApp(stubCtx);
      const res = await app.inject({
        method: "POST",
        url: "/api/flows/recon/runs",
        payload: { input: {}, evil: 1 },
      });
      expect(res.statusCode).toBe(400);
      // additionalProperties:false makes the unexpected key a hard reject, not a
      // silent strip (removeAdditional is off for this app).
      expect(res.json().message).toMatch(/additional properties/i);
      await app.close();
    });

    it("rejects an unknown top-level key on the approval decision body with 400", async () => {
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
      const app = await buildApp(stubCtx);
      const res = await app.inject({
        method: "POST",
        url: "/api/approvals/11111111-1111-1111-1111-111111111111/decision",
        payload: { decision: "approved", evil: 1 },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("preserves the domain 400 for a bad decision value, not a schema reject", async () => {
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
      const app = await buildApp(stubCtx);
      const res = await app.inject({
        method: "POST",
        url: "/api/approvals/11111111-1111-1111-1111-111111111111/decision",
        payload: { decision: "maybe" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'decision must be "approved" or "rejected"' });
      await app.close();
    });
  });

  describe("I-JSON ingress guard (well-formed Unicode, fail closed)", () => {
    afterEach(() => {
      delete process.env.MAKERCHECKER_AUTH_DISABLED;
    });

    it("rejects a lone surrogate in a run input with a 400 naming the JSON path", async () => {
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
      const app = await buildApp(stubCtx);
      // Raw body: JSON.parse accepts the lone-surrogate escape, but such a
      // string is not I-JSON and has no interoperable RFC 8785 serialization.
      // It must be a clean 400 at ingress, not a 500 from the canonicalizer
      // throwing deep inside the audit transaction.
      const res = await app.inject({
        method: "POST",
        url: "/api/flows/recon/runs",
        headers: { "content-type": "application/json" },
        payload: '{"input":{"note":"\\ud800"}}',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: "payload contains ill-formed Unicode (unpaired surrogate) at $.input.note",
      });
      await app.close();
    });

    it("rejects a lone surrogate in an object KEY", async () => {
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
      const app = await buildApp(stubCtx);
      const res = await app.inject({
        method: "POST",
        url: "/api/flows/recon/runs",
        headers: { "content-type": "application/json" },
        payload: '{"input":{"\\udc00key":1}}',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("ill-formed Unicode (unpaired surrogate)");
      await app.close();
    });

    it("rejects a lone surrogate in an approval decision reason", async () => {
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
      const app = await buildApp(stubCtx);
      const res = await app.inject({
        method: "POST",
        url: "/api/approvals/11111111-1111-1111-1111-111111111111/decision",
        headers: { "content-type": "application/json" },
        payload: '{"decision":"approved","reason":"ok\\udfff"}',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: "payload contains ill-formed Unicode (unpaired surrogate) at $.reason",
      });
      await app.close();
    });

    it("is inert for well-formed Unicode (astral emoji, NFC/NFD pairs)", async () => {
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
      const app = await buildApp(stubCtx);
      const res = await app.inject({
        method: "POST",
        url: "/api/flows/recon/runs",
        payload: { input: { emoji: "\u{1F600}", nfc: "é", nfd: "é" } },
      });
      // The guard must not fire (the stub ctx fails later, in the engine, for
      // unrelated reasons); valid data is never rejected and never re-encoded.
      expect(res.statusCode).not.toBe(400);
      expect(res.body).not.toContain("ill-formed Unicode");
      await app.close();
    });
  });

  describe("id param validation and error handling", () => {
    afterEach(() => {
      delete process.env.MAKERCHECKER_AUTH_DISABLED;
    });

    it("returns 400 (not a 500 + Postgres leak) for a non-UUID run id", async () => {
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
      const app = await buildApp(stubCtx);
      const res = await app.inject({ method: "GET", url: "/api/runs/not-a-uuid" });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain("22P02");
      await app.close();
    });

    it("returns 400 for a non-UUID approval id", async () => {
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
      const app = await buildApp(stubCtx);
      const res = await app.inject({
        method: "POST",
        url: "/api/approvals/not-a-uuid/decision",
        payload: { decision: "approved" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("returns a generic 500 without leaking an internal error message", async () => {
      // A ctx whose query throws an infra error carrying host:port + a secret.
      const throwingCtx = {
        pool: {
          query: async () => {
            throw new Error("connect ECONNREFUSED 10.0.3.5:5432 internal-db.secret.host");
          },
        },
      } as unknown as EngineContext;
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
      const app = await buildApp(throwingCtx);
      const res = await app.inject({
        method: "GET",
        url: "/api/runs/11111111-1111-1111-1111-111111111111",
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "internal error" });
      // The raw error message (DB host:port, secret) must not reach the client.
      expect(res.body).not.toContain("ECONNREFUSED");
      expect(res.body).not.toContain("secret.host");
      await app.close();
    });
  });

  describe("rate limiting", () => {
    const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
      delete process.env.MAKERCHECKER_DISABLE_RATE_LIMIT;
    });

    it("is inert under the test default so the suite never sees a 429", async () => {
      // NODE_ENV is "test" here (vitest sets it): the plugin is not registered,
      // so a burst well past the limit still all succeeds.
      const app = await buildApp();
      for (let i = 0; i < 150; i++) {
        const res = await app.inject({ method: "GET", url: "/healthz" });
        expect(res.statusCode).toBe(200);
      }
      await app.close();
    });

    it("returns 429 past the limit when enabled, but never on the allow-listed /healthz", async () => {
      // Flip out of test mode so buildApp registers the limiter.
      process.env.NODE_ENV = "production";
      delete process.env.MAKERCHECKER_DISABLE_RATE_LIMIT;
      const app = await buildApp(stubCtx);

      // /healthz is allow-listed: it must never be throttled.
      for (let i = 0; i < 120; i++) {
        const res = await app.inject({ method: "GET", url: "/healthz" });
        expect(res.statusCode).toBe(200);
      }

      // A non-allow-listed route from one IP trips the 100/min limit. The
      // rate-limit hook runs before /api auth, so the pre-limit replies are
      // 401s (no key) and the post-limit reply is a 429.
      let saw429 = false;
      for (let i = 0; i < 130; i++) {
        const res = await app.inject({ method: "GET", url: "/api/runs" });
        if (res.statusCode === 429) {
          saw429 = true;
          break;
        }
      }
      expect(saw429).toBe(true);
      await app.close();
    });

    it("stays inert when MAKERCHECKER_DISABLE_RATE_LIMIT=1 even outside test mode", async () => {
      process.env.NODE_ENV = "production";
      process.env.MAKERCHECKER_DISABLE_RATE_LIMIT = "1";
      const app = await buildApp(stubCtx);
      for (let i = 0; i < 150; i++) {
        const res = await app.inject({ method: "GET", url: "/healthz" });
        expect(res.statusCode).toBe(200);
      }
      await app.close();
    });
  });

  describe("structured access logging", () => {
    afterEach(() => {
      delete process.env.MAKERCHECKER_AUTH_DISABLED;
      delete process.env.MAKERCHECKER_REDACTION;
    });

    it("emits one access line per response carrying a correlation id", async () => {
      const { app, lines } = await buildAppWithCapturedLog();
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      await app.close();
      const access = lines().find((l) => l.msg === "request completed");
      expect(access).toBeDefined();
      expect(access).toMatchObject({ method: "GET", url: "/healthz", statusCode: 200 });
      expect(typeof access?.reqId).toBe("string");
      expect((access?.reqId as string).length).toBeGreaterThan(0);
    });

    it("propagates an inbound x-request-id as the correlation id", async () => {
      const { app, lines } = await buildAppWithCapturedLog();
      const res = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: { "x-request-id": "trace-abc-123" },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
      const access = lines().find((l) => l.msg === "request completed");
      expect(access?.reqId).toBe("trace-abc-123");
    });

    it("never logs the Bearer token or a planted mk_ key in the access line", async () => {
      // A stub pool so /api/runs reaches the access log; auth is on, so the
      // request 401s before any handler — the access line is still emitted, and
      // must not carry the planted credential.
      const stubCtx = {
        pool: { query: async () => ({ rows: [] }) },
      } as unknown as EngineContext;
      const { app, lines } = await buildAppWithCapturedLog(stubCtx);
      const token = `mk_${randomBytes(16).toString("hex")}`;
      const res = await app.inject({
        method: "GET",
        url: "/api/runs",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
      const serialized = JSON.stringify(lines());
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain("Bearer");
    });

    it("logs a redacted structured error for a >=500 without leaking infra details", async () => {
      const throwingCtx = {
        pool: {
          query: async () => {
            throw new Error("connect ECONNREFUSED 10.0.3.5:5432 user@secret.host");
          },
        },
      } as unknown as EngineContext;
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
      const { app, lines } = await buildAppWithCapturedLog(throwingCtx);
      const res = await app.inject({
        method: "GET",
        url: "/api/runs/11111111-1111-1111-1111-111111111111",
      });
      expect(res.statusCode).toBe(500);
      await app.close();
      const errLine = lines().find((l) => l.msg === "unhandled error");
      expect(errLine).toBeDefined();
      // The error is logged server-side (so it is reachable for triage) but the
      // generic client body never carried the infra detail.
      expect(res.body).not.toContain("ECONNREFUSED");
    });

    it("redacts planted PII from BOTH the error message and stack in the error log", async () => {
      const email = "victim@bank.example";
      const card = "4111111111111111";
      const throwingCtx = {
        pool: {
          query: async () => {
            throw new Error(`boom ${email} account=${card}`);
          },
        },
      } as unknown as EngineContext;
      process.env.MAKERCHECKER_AUTH_DISABLED = "1";
      process.env.MAKERCHECKER_REDACTION = "example";
      const { app, lines } = await buildAppWithCapturedLog(throwingCtx);
      const res = await app.inject({
        method: "GET",
        url: "/api/runs/11111111-1111-1111-1111-111111111111",
      });
      expect(res.statusCode).toBe(500);
      await app.close();
      // The message is on the stack's first line, so both fields must be clean.
      const serialized = JSON.stringify(lines().find((l) => l.msg === "unhandled error"));
      expect(serialized).not.toContain(email);
      expect(serialized).not.toContain(card);
    });
  });
});
