import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: {
          name: "core",
          include: ["apps/*/test/**/*.test.ts", "packages/**/test/**/*.test.ts"],
          exclude: ["apps/web/**", "**/node_modules/**"],
          setupFiles: ["test/no-real-agents.ts"],
        },
      },
      // The Web UI compiles .vue files and runs in a DOM (ADR 0017).
      "apps/web/vitest.config.ts",
    ],
  },
});
