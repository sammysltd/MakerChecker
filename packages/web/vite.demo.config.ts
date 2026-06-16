import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
// makerchecker-site is a SIBLING of the makerchecker repo:
//   Code/makerchecker/packages/web -> up 3 -> Code -> makerchecker-site
const OUT = resolve(here, "../../../makerchecker-site/public/demo");

/**
 * Builds the standalone live demo (demo.html -> src/demo/main.tsx) as static
 * files under the marketing site's public/demo, so it ships with the site on
 * the next deploy. Hosted at /demo/, base set accordingly. The output is the
 * REAL product components fed by captured fixtures — see DemoApp.tsx.
 *
 * Regenerate: pnpm --filter @makerchecker/web build:demo
 */

// Vite names the emitted HTML after its source (demo.html); /demo/ needs an
// index.html, so rename it once the bundle is written.
function htmlAsIndex(): Plugin {
  return {
    name: "demo-html-as-index",
    async closeBundle() {
      const { rename } = await import("node:fs/promises");
      await rename(resolve(OUT, "demo.html"), resolve(OUT, "index.html"));
    },
  };
}

export default defineConfig({
  base: "/demo/",
  plugins: [react(), htmlAsIndex()],
  build: {
    outDir: OUT,
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(here, "demo.html"),
    },
  },
});
