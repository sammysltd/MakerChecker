import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { EngineContext } from "./engine/orchestrator.js";

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
});
