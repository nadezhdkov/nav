import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchesPath, verify } from "../src/index.ts";

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "navarch-verify-"));
  writeFileSync(join(dir, "ok.txt"), "ok\n");
  return dir;
}

const base = { env: process.env, timeoutMs: 10_000, onOutput: () => {} };

describe("verify", () => {
  it("runs each check in the sandbox and passes when all succeed", async () => {
    const report = await verify({
      ...base,
      cwd: sandbox(),
      checks: [
        { name: "exists", run: "test -f ok.txt", required: true },
        { name: "echo", run: "echo hello", required: true },
      ],
      changedFiles: ["src/a.ts"],
      protectedPaths: [],
    });
    expect(report.passed).toBe(true);
    expect(report.blocking_failures).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.checks.map((c) => [c.name, c.exit_code])).toEqual([
      ["exists", 0],
      ["echo", 0],
    ]);
    expect(report.checks[1]?.output_tail).toBe("hello");
  });

  it("blocks on a failing required check and only warns on an optional one", async () => {
    const report = await verify({
      ...base,
      cwd: sandbox(),
      checks: [
        { name: "lint", run: "echo 'E501 line too long' >&2; exit 1", required: false },
        { name: "test", run: "echo '1 failed'; exit 2", required: true },
        { name: "after", run: "true", required: true },
      ],
      changedFiles: [],
      protectedPaths: [],
    });
    expect(report.passed).toBe(false);
    expect(report.blocking_failures).toEqual(["test: `echo '1 failed'; exit 2` exited with 2: 1 failed"]);
    expect(report.warnings).toEqual(["lint (optional): `echo 'E501 line too long' >&2; exit 1` exited with 1: E501 line too long"]);
    // Later checks still run, so the report shows everything that is wrong at once.
    expect(report.checks.map((c) => c.name)).toEqual(["lint", "test", "after"]);
  });

  it("warns that a run without checks is unverified", async () => {
    const report = await verify({ ...base, cwd: sandbox(), checks: [], changedFiles: ["a"], protectedPaths: [] });
    expect(report).toMatchObject({ passed: true, blocking_failures: [] });
    expect(report.warnings).toEqual(["unverified: the project defines no verify commands (.navarch/project.yaml)"]);
  });

  it("warns about changed files under protected paths", async () => {
    const report = await verify({
      ...base,
      cwd: sandbox(),
      checks: [{ name: "ok", run: "true", required: true }],
      changedFiles: ["src/a.ts", ".github/workflows/ci.yml", "web/package.json", "config/.env.local"],
      protectedPaths: [".github/workflows/**", "package.json", "**/*.env*"],
    });
    expect(report.passed).toBe(true);
    expect(report.warnings).toEqual([
      "protected path changed: .github/workflows/ci.yml",
      "protected path changed: web/package.json",
      "protected path changed: config/.env.local",
    ]);
  });

  it("stops at once when aborted and reports the check as killed", async () => {
    const abort = new AbortController();
    const started = Date.now();
    const pending = verify({
      ...base,
      cwd: sandbox(),
      checks: [
        { name: "slow", run: "sleep 30", required: true },
        { name: "never", run: "true", required: true },
      ],
      changedFiles: [],
      protectedPaths: [],
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 100);
    const report = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.passed).toBe(false);
    expect(report.checks.map((c) => [c.name, c.exit_code])).toEqual([["slow", null]]);
  });
});

describe("matchesPath", () => {
  it("matches gitignore-like globs", () => {
    expect(matchesPath(".github/workflows/**", ".github/workflows/a/b.yml")).toBe(true);
    expect(matchesPath(".github/workflows/**", ".github/other.yml")).toBe(false);
    expect(matchesPath("package.json", "package.json")).toBe(true);
    expect(matchesPath("package.json", "apps/web/package.json")).toBe(true);
    expect(matchesPath("package.json", "package.json.bak")).toBe(false);
    expect(matchesPath("**/*.env*", ".env")).toBe(true);
    expect(matchesPath("**/*.env*", "a/b/prod.env.local")).toBe(true);
    expect(matchesPath("src/*.ts", "src/a/b.ts")).toBe(false);
  });
});
