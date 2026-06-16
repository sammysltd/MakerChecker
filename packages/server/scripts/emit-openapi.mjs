#!/usr/bin/env node
/**
 * Emits the server's OpenAPI document to packages/sdk/openapi.json.
 *
 * Builds the app with a dummy engine context: route handlers close over ctx
 * lazily and are never invoked here — only the route *schemas* are needed to
 * produce the spec. Run `pnpm build` first (imports from dist/).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildApp } from "../dist/app.js";

const dummyCtx = { pool: {}, backend: {}, executor: {} };
const app = await buildApp(dummyCtx);
await app.ready();

const document = app.swagger();
const outPath = fileURLToPath(new URL("../../sdk/openapi.json", import.meta.url));
writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${outPath} (${Object.keys(document.paths ?? {}).length} paths)`);

await app.close();
