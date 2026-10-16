import { defineConfig } from "vitest/config";
import { NO_REAL_AGENTS, TEST_TIMEOUT } from "./test/package-vitest.ts";

export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT,
    projects: [
      {
        extends: true,
        test: {
          name: "core",
          include: ["apps/*/test/**/*.test.ts", "packages/**/test/**/*.test.ts"],
          exclude: ["apps/web/**", "**/node_modules/**"],
          setupFiles: [NO_REAL_AGENTS],
        },
      },
      // The Web UI compiles .vue files and runs in a DOM (ADR 0017).
      "apps/web/vitest.config.ts",
    ],
  },
});
