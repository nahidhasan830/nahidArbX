import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["lib/**/*.ts"],
      exclude: ["lib/db/migrations/**", "lib/shared/logger.ts", "**/*.d.ts"],
    },
    include: ["tests/**/*.test.ts"],
  },
});
