import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

describe("tests never reach a real agent CLI", () => {
  it("runs with the agent CLIs stubbed out on PATH", () => {
    const run = spawnSync("grok", ["--version"], { encoding: "utf8" });
    expect(run.status).toBe(127);
    expect(run.stderr).toContain("test tried to run the real grok CLI");
  });

  it("gives every package with core tests a vitest config that keeps the stubs", () => {
    const dirs = [
      ...["apps/cli", "apps/daemon"],
      ...readdirSync(join(root, "packages")).filter((d) => d !== "adapters").map((d) => `packages/${d}`),
      ...readdirSync(join(root, "packages/adapters")).map((d) => `packages/adapters/${d}`),
    ].filter((d) => existsSync(join(root, d, "test")));
    for (const d of dirs) {
      const config = join(root, d, "vitest.config.ts");
      expect(existsSync(config), `${d} has no vitest.config.ts`).toBe(true);
      expect(readFileSync(config, "utf8"), d).toContain("test/package-vitest.ts");
    }
  });
});
