import { defineConfig } from "vitest/config";

// Unit tests run in plain Node, without the Cloudflare and React plugins from vite.config.ts.
// Database tests against a remote cluster (MONGODB_TEST_URI) make many round trips, so they get longer.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: process.env.MONGODB_TEST_URI ? 30_000 : 5_000, hookTimeout: 30_000 },
});
