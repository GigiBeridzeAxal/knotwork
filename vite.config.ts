import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const punycode = fileURLToPath(new URL("./node_modules/punycode/punycode.js", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
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
