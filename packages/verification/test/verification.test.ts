import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerIsolation } from "@navarch/contracts";
import { fakeDocker } from "../../runner/test/fake-docker.ts";
import { makeRepo } from "../../runner/test/helpers.ts";
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

const isolation: ContainerIsolation = { kind: "container", image: "node:22-bookworm-slim", network: "none", memory: "2g", cpus: 1, pids_limit: 256 };

describe("verify in a container (L2, ADR 0035)", () => {
  it("runs each check in its own locked-down container with only the worktree mounted", async () => {
    const docker = fakeDocker();
    const repo = makeRepo();
    process.env.NAVARCH_TEST_LEAK = "secret-value";
    const report = await verify({
      ...base,
      cwd: repo,
      checks: [
        { name: "readme", run: "test -f README.md", required: true },
        { name: "env", run: "test -z \"$NAVARCH_TEST_LEAK\" && test \"$HOME\" = /tmp", required: true },
      ],
      changedFiles: [],
      protectedPaths: [],
      container: { runtime: docker.runtime, isolation, name: "navarch-tsk_1-1" },
    });
    delete process.env.NAVARCH_TEST_LEAK;
    expect(report).toMatchObject({ passed: true, blocking_failures: [], sandbox: { kind: "container", image: "node:22-bookworm-slim", network: "none" } });
    const runs = docker.calls().filter((c) => c[0] === "run");
    expect(runs).toHaveLength(2);
    const uid = process.getuid!();
    expect(runs[0]).toEqual(expect.arrayContaining([
      "--rm", "--name=navarch-tsk_1-1-1", "--network=none", `--user=${uid}:${process.getgid!()}`, "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--read-only", "--memory=2g", "--cpus=1", "--pids-limit=256", `--volume=${repo}:${repo}:rw`, `--workdir=${repo}`, "--env=HOME=/tmp",
    ]));
    expect(runs[0]!.slice(-4)).toEqual(["node:22-bookworm-slim", "sh", "-c", "test -f README.md"]);
    expect(runs[1]![runs[1]!.indexOf("--name=navarch-tsk_1-1-2")]).toBeDefined();
    // Nothing from the daemon's environment is handed to the container.
    expect(runs.flat().some((a) => a.includes("secret-value") || a.startsWith("--env=PATH"))).toBe(false);
  });

  it("mounts the repository's git directory read-only for a linked worktree", async () => {
    const docker = fakeDocker();
    const repo = makeRepo();
    const wt = join(mkdtempSync(join(tmpdir(), "navarch-wt-")), "wt");
    execFileSync("git", ["worktree", "add", "-q", "-b", "navarch/r/t", wt], { cwd: repo });
    await verify({ ...base, cwd: wt, checks: [{ name: "x", run: "true", required: true }], changedFiles: [], protectedPaths: [], container: { runtime: docker.runtime, isolation, name: "n" } });
    const run = docker.calls().find((c) => c[0] === "run")!;
    expect(run).toContain(`--volume=${join(repo, ".git")}:${join(repo, ".git")}:ro`);
  });

  it("fails without running anything on the host when the runtime is unavailable", async () => {
    const docker = fakeDocker({ down: true });
    const dir = sandbox();
    const report = await verify({ ...base, cwd: dir, checks: [{ name: "touch", run: "touch ran.txt", required: true }], changedFiles: [], protectedPaths: [], container: { runtime: docker.runtime, isolation, name: "n" } });
    expect(report.passed).toBe(false);
    expect(report.checks).toEqual([]);
    expect(report.blocking_failures[0]).toMatch(/^container runtime unavailable: `.*docker version` exited with 1: Cannot connect to the Docker daemon/);
    expect(existsSync(join(dir, "ran.txt"))).toBe(false);
    expect(docker.calls().map((c) => c[0])).toEqual(["version"]);
  });

  it("fails the same way when the runtime command does not exist", async () => {
    const report = await verify({ ...base, cwd: sandbox(), checks: [{ name: "x", run: "true", required: true }], changedFiles: [], protectedPaths: [], container: { runtime: "/nonexistent/docker", isolation, name: "n" } });
    expect(report.passed).toBe(false);
    expect(report.blocking_failures[0]).toContain("container runtime unavailable");
  });

  it("removes the container when the check is cancelled", async () => {
    const docker = fakeDocker();
    const controller = new AbortController();
    const pending = verify({ ...base, cwd: makeRepo(), checks: [{ name: "slow", run: "sleep 30", required: true }], changedFiles: [], protectedPaths: [], container: { runtime: docker.runtime, isolation, name: "navarch-slow" }, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 500));
    controller.abort();
    const report = await pending;
    expect(report.checks[0]?.exit_code).toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    expect(docker.calls()).toContainEqual(["rm", "--force", "navarch-slow-1"]);
  });
});

/**
 * Against the real Docker, opt-in (`NAVARCH_TEST_DOCKER=1`): needs a running daemon and an image
 * already pulled (`NAVARCH_TEST_DOCKER_IMAGE`, default python:3.12-slim-bookworm), so it uses no network.
 */
describe.skipIf(!process.env.NAVARCH_TEST_DOCKER)("verify in a real Docker container", () => {
  it("sees the worktree, has no network, is not root and cannot see the daemon's environment", { timeout: 120_000 }, async () => {
    const repo = makeRepo();
    process.env.NAVARCH_TEST_LEAK = "secret-value";
    const report = await verify({
      ...base,
      timeoutMs: 60_000,
      cwd: repo,
      checks: [
        { name: "worktree", run: "test -f README.md && echo made > made.txt", required: true },
        { name: "network", run: "test \"$(ls /sys/class/net)\" = lo", required: true },
        { name: "user", run: "test \"$(id -u)\" != 0", required: true },
        { name: "env", run: "test -z \"$NAVARCH_TEST_LEAK\"", required: true },
        { name: "rootfs", run: "! touch /etc/navarch 2>/dev/null", required: true },
      ],
      changedFiles: [],
      protectedPaths: [],
      container: { runtime: process.env.NAVARCH_TEST_DOCKER_RUNTIME ?? "/usr/bin/docker", isolation: { ...isolation, image: process.env.NAVARCH_TEST_DOCKER_IMAGE ?? "python:3.12-slim-bookworm" }, name: `navarch-test-${process.pid}` },
    });
    delete process.env.NAVARCH_TEST_LEAK;
    expect(report.blocking_failures).toEqual([]);
    expect(statSync(join(repo, "made.txt")).uid).toBe(process.getuid!());
  });
});
