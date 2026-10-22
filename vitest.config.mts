import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `server-only` throws outside the React Server bundle; it is a no-op in tests.
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: process.env.LIVE_TESTS ? ["tests/live/**/*.test.ts"] : ["tests/**/*.test.ts"],
    exclude: process.env.LIVE_TESTS ? [] : ["tests/live/**", "node_modules/**"],
    testTimeout: 20_000,
  },
});
