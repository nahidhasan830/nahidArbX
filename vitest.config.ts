import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["lib/**/*.ts"],
      exclude: ["lib/db/migrations/**", "lib/shared/logger.ts", "**/*.d.ts"],
    },
    include: ["tests/**/*.test.ts"],
  },
});
