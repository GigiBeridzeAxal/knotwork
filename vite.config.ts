import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

const punycode = fileURLToPath(new URL("./node_modules/punycode/punycode.js", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  // /api/health reports which build is live. Workers Builds sets WORKERS_CI_COMMIT_SHA; a build made
  // anywhere else says "local".
  define: {
    __KNOTWORK_BUILD__: JSON.stringify({ version: pkg.version, commit: (process.env.WORKERS_CI_COMMIT_SHA ?? "local").slice(0, 12) }),
  },
  resolve: {
    // The MongoDB driver's URL parser asks for "punycode/" (the npm package, not Node's deprecated
    // built-in). Point it at the package so the Worker bundle includes it.
    alias: { "punycode/": punycode },
  },
  environments: {
    // The dev server pre-bundles the Worker's dependencies separately; give it the same alias.
    knotwork: {
      optimizeDeps: {
        rolldownOptions: {
          plugins: [{ name: "punycode-package", resolveId: (id: string) => (id === "punycode/" ? punycode : null) }],
        },
      },
    },
  },
});
