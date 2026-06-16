import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Serves the built web SPA (packages/web/dist) from the API server so a
 * single container exposes both. The dist directory is located via
 * MAKERCHECKER_WEB_DIST or the default monorepo-relative path; when absent,
 * the server is API-only and 404 behaviour is untouched.
 */

/**
 * API route prefixes that must keep returning JSON 404s, never index.html.
 * Every API route lives under /api (see app.ts), so SPA routes like
 * /runs/:id can never collide with it.
 */
const API_PREFIXES = ["/api", "/healthz"];

/** True when the path belongs to the API surface (exact prefix or a subpath). */
export function isApiPath(path: string): boolean {
  const clean = path.split("?")[0] ?? path;
  return API_PREFIXES.some(
    (prefix) => clean === prefix || clean.startsWith(`${prefix}/`),
  );
}

/** Resolve the web dist directory: env override, else ../../web/dist from here. */
export function resolveWebDist(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir =
    env.MAKERCHECKER_WEB_DIST ??
    join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir is the operator-configured web dist (env override or fixed module-relative path) and the filename is a constant, not request input.
  return existsSync(join(dir, "index.html")) ? dir : null;
}

/**
 * Register static serving + SPA fallback. The fallback serves index.html only
 * for GET requests that accept text/html and are NOT under an API prefix —
 * API 404s stay JSON.
 */
export async function registerWebStatic(
  app: FastifyInstance,
  webDist: string,
): Promise<void> {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });

  app.setNotFoundHandler((req, reply) => {
    const accept = req.headers.accept ?? "";
    if (req.method === "GET" && accept.includes("text/html") && !isApiPath(req.url)) {
      return reply.type("text/html; charset=utf-8").sendFile("index.html");
    }
    return reply.status(404).send({ error: "not found" });
  });
}
