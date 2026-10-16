import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** The real-agent stubs every core test runs with (see `no-real-agents.ts`). */
export const NO_REAL_AGENTS = fileURLToPath(new URL("./no-real-agents.ts", import.meta.url));
export const TEST_TIMEOUT = 20_000;

/**
 * Vitest config for running one package's tests from inside that package (`cd apps/daemon &&
 * vitest`, or a tool's `vitest related`). Vitest only reads the config of the directory it starts
 * in, so without this the root's timeout and, worse, its real-agent stubs were left out: a routing
 * test then picked the operator's signed-in `grok` CLI.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: TEST_TIMEOUT,
    setupFiles: [NO_REAL_AGENTS],
  },
});
