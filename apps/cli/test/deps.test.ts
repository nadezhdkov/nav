import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutRoot, installProblem, startFailureHint } from "../src/deps.ts";

function checkout(lock: string, installed?: string): string {
  const root = mkdtempSync(join(tmpdir(), "navarch-deps-"));
  writeFileSync(join(root, "pnpm-lock.yaml"), lock);
  if (installed !== undefined) {
    mkdirSync(join(root, "node_modules", ".pnpm"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".pnpm", "lock.yaml"), installed);
  }
  return root;
}

const MAIN = "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n";

describe("stale dependencies (go/no-go F3)", () => {
  it("accepts an install that matches the lockfile's last document", () => {
    expect(installProblem(checkout(`---\nlockfileVersion: '9.0'\npnpm: {}\n\n---\n${MAIN}`, MAIN))).toBeUndefined();
    expect(installProblem(checkout(MAIN, MAIN))).toBeUndefined();
  });

  it("says to run make install when the lockfile changed or nothing is installed", () => {
    expect(installProblem(checkout(`${MAIN}  apps/new: {}\n`, MAIN))).toMatch(/older than pnpm-lock\.yaml: run `make install`/);
    expect(installProblem(checkout(MAIN))).toMatch(/not installed.*make install/);
  });

  it("finds the checkout above a file", () => {
    const root = checkout(MAIN, MAIN);
    mkdirSync(join(root, "apps", "cli", "src"), { recursive: true });
    expect(checkoutRoot(join(root, "apps", "cli", "src", "main.ts"))).toBe(root);
  });

  it("explains a daemon that died on a missing workspace package", () => {
    const log = "node:internal/modules/esm/resolve:873\nError [ERR_MODULE_NOT_FOUND]: Cannot find package '@navarch/adapter-copilot' imported from /x/daemon.ts";
    expect(startFailureHint(log)).toBe("@navarch/adapter-copilot is missing: the dependencies are out of date. Run `make install`, then start the daemon again.");
    expect(startFailureHint("Error: listen EADDRINUSE")).toBeUndefined();
  });
});
