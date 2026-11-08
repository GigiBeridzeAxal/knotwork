import { defineConfig } from "vitest/config";

// Unit tests run in plain Node, without the Cloudflare and React plugins from vite.config.ts.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
