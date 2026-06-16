import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { EngineContext } from "./engine/orchestrator.js";
import { isApiPath, resolveWebDist } from "./web-static.js";

const INDEX_HTML = "<!doctype html><html><body>makerchecker spa</body></html>";

let fixtureDist: string;

beforeAll(() => {
  fixtureDist = mkdtempSync(join(tmpdir(), "mc-web-dist-"));
  writeFileSync(join(fixtureDist, "index.html"), INDEX_HTML);
  mkdirSync(join(fixtureDist, "assets"));
  writeFileSync(join(fixtureDist, "assets", "app.js"), "console.log('mc')");
});

afterAll(() => {
  rmSync(fixtureDist, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.MAKERCHECKER_WEB_DIST;
});

describe("isApiPath", () => {
  it("matches /api and /healthz exactly and as subpaths", () => {
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/api/runs")).toBe(true);
    expect(isApiPath("/api/runs/abc-123")).toBe(true);
    expect(isApiPath("/api/flows/recon/runs")).toBe(true);
    expect(isApiPath("/api/audit/verify")).toBe(true);
    expect(isApiPath("/api/openapi.json")).toBe(true);
    expect(isApiPath("/healthz")).toBe(true);
    expect(isApiPath("/api/approvals?x=1")).toBe(true);
  });

  it("does not match SPA paths or look-alike prefixes", () => {
    expect(isApiPath("/")).toBe(false);
    expect(isApiPath("/apiabc")).toBe(false);
    expect(isApiPath("/about")).toBe(false);
    // SPA routes share names with API resources but live at the root.
    expect(isApiPath("/runs")).toBe(false);
    expect(isApiPath("/runs/abc-123")).toBe(false);
    expect(isApiPath("/approvals")).toBe(false);
    expect(isApiPath("/skills")).toBe(false);
  });
});

describe("resolveWebDist", () => {
  it("returns the env-pointed directory when it has an index.html", () => {
    expect(resolveWebDist({ MAKERCHECKER_WEB_DIST: fixtureDist })).toBe(fixtureDist);
  });

  it("returns null when the directory has no index.html", () => {
    expect(resolveWebDist({ MAKERCHECKER_WEB_DIST: join(tmpdir(), "nope-mc") })).toBeNull();
  });
});

describe("static serving with a fixture dist", () => {
  it("serves index.html at / and real asset files", async () => {
    process.env.MAKERCHECKER_WEB_DIST = fixtureDist;
    const app = await buildApp();
    const index = await app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain("makerchecker spa");
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("console.log");
    await app.close();
  });

  it("SPA-fallbacks unknown GET paths that accept text/html", async () => {
    process.env.MAKERCHECKER_WEB_DIST = fixtureDist;
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/runs-view/deep/link",
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("makerchecker spa");
    await app.close();
  });

  it("keeps JSON 404s for API prefixes even when the client accepts html", async () => {
    process.env.MAKERCHECKER_WEB_DIST = fixtureDist;
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/runs/not-a-real-route/extra",
      headers: { accept: "text/html" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
    await app.close();
  });

  it("keeps JSON 404s for non-html and non-GET requests", async () => {
    process.env.MAKERCHECKER_WEB_DIST = fixtureDist;
    const app = await buildApp();
    const json = await app.inject({
      method: "GET",
      url: "/whatever",
      headers: { accept: "application/json" },
    });
    expect(json.statusCode).toBe(404);
    expect(json.json()).toEqual({ error: "not found" });
    const post = await app.inject({
      method: "POST",
      url: "/whatever",
      headers: { accept: "text/html" },
    });
    expect(post.statusCode).toBe(404);
    expect(post.json()).toEqual({ error: "not found" });
    await app.close();
  });
});

describe("SPA/API route split — the /runs/:id collision regression", () => {
  // Route handlers close over the pool lazily; a stub returning no rows is
  // enough to exercise the routing + auth layers without a database.
  const stubCtx = {
    pool: { query: async () => ({ rows: [] }) },
    backend: {},
    executor: {},
  } as unknown as EngineContext;
  const uuid = "11111111-1111-1111-1111-111111111111";

  it("full-page-loads /runs/<uuid> as the SPA, not API JSON", async () => {
    process.env.MAKERCHECKER_WEB_DIST = fixtureDist;
    const app = await buildApp(stubCtx);
    const res = await app.inject({
      method: "GET",
      url: `/runs/${uuid}`,
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("makerchecker spa");
    await app.close();
  });

  it("keeps /api/runs/<uuid> JSON: 401 with auth enabled", async () => {
    process.env.MAKERCHECKER_WEB_DIST = fixtureDist;
    const app = await buildApp(stubCtx);
    const res = await app.inject({
      method: "GET",
      url: `/api/runs/${uuid}`,
      headers: { accept: "text/html" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json().error).toContain("missing API key");
    await app.close();
  });

  it("keeps /api/runs/<uuid> JSON: 404 for an unknown id with auth disabled", async () => {
    process.env.MAKERCHECKER_WEB_DIST = fixtureDist;
    process.env.MAKERCHECKER_AUTH_DISABLED = "1";
    try {
      const app = await buildApp(stubCtx);
      const res = await app.inject({
        method: "GET",
        url: `/api/runs/${uuid}`,
        headers: { accept: "text/html" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.json()).toEqual({ error: "run not found" });
      await app.close();
    } finally {
      delete process.env.MAKERCHECKER_AUTH_DISABLED;
    }
  });
});

describe("when no dist directory exists", () => {
  it("API 404s still return JSON and no static route is registered", async () => {
    process.env.MAKERCHECKER_WEB_DIST = join(tmpdir(), "definitely-missing-mc-dist");
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/nope",
      headers: { accept: "text/html" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    await app.close();
  });
});
