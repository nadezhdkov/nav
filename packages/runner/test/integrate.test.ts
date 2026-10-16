import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { concludeMerge, createWorktree, forkWorktree, mergeBranch } from "../src/index.ts";
import { makeRepo, tempHome } from "./helpers.ts";

const head = (cwd: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const log = (cwd: string) => execFileSync("git", ["log", "--format=%an %s"], { cwd, encoding: "utf8" });

async function setup() {
  const repoPath = makeRepo();
  const home = tempHome();
  const baseCommit = head(repoPath);
  const shared = await createWorktree({ sandboxId: "sbx_shared", repoPath, runId: "run_1", taskSlug: "team", baseCommit, home });
  const fork = (key: string) =>
    forkWorktree({ sandboxId: `sbx_${key}`, repoPath, runId: "run_1", taskSlug: `team-${key}`, baseCommit, home, from: shared });
  return { repoPath, shared, fork };
}

describe("parallel member worktrees (ADR 0029)", () => {
  it("forks from the shared worktree's HEAD, with its uncommitted work committed first", async () => {
    const { shared, fork } = await setup();
    writeFileSync(join(shared.path, "lead.txt"), "from the lead\n");
    const a = await fork("a");
    expect(a).toMatchObject({ branch: "navarch/run_1/team-a", reused: false });
    expect(readFileSync(join(a.path, "lead.txt"), "utf8")).toBe("from the lead\n");
    expect(a.baseCommit).toBe(head(shared.path));
    expect(log(shared.path)).toMatch(/^Navarch /);

    // A retry reuses the worktree, and its fork point stays the same after the shared branch moves.
    writeFileSync(join(shared.path, "later.txt"), "x\n");
    await fork("b");
    const again = await fork("a");
    expect(again).toMatchObject({ reused: true, baseCommit: a.baseCommit });
  });

  it("forks from the base when the shared worktree does not exist yet, also when reused (ADR 0031)", async () => {
    const repoPath = makeRepo();
    const home = tempHome();
    const baseCommit = head(repoPath);
    const missing = { id: "", kind: "worktree" as const, path: join(home, "nowhere"), branch: "navarch/run_2/compete", baseCommit };
    const fork = () => forkWorktree({ sandboxId: "sbx_c1", repoPath, runId: "run_2", taskSlug: "compete-c1", baseCommit, home, from: missing });
    const c1 = await fork();
    expect(c1).toMatchObject({ branch: "navarch/run_2/compete-c1", baseCommit, reused: false });
    writeFileSync(join(c1.path, "c1.txt"), "c1\n");
    expect(await fork()).toMatchObject({ reused: true, baseCommit });
  });

  it("merges a member's branch, committing its work as Navarch; merging again is a no-op", async () => {
    const { repoPath, shared, fork } = await setup();
    const a = await fork("a");
    writeFileSync(join(a.path, "a.txt"), "a\n");
    const b = await fork("b");
    writeFileSync(join(b.path, "b.txt"), "b\n");
    expect(await mergeBranch({ repoPath, target: shared, source: a, message: "Merge team member a" })).toEqual({ merged: true });
    expect(await mergeBranch({ repoPath, target: shared, source: b, message: "Merge team member b" })).toEqual({ merged: true });
    expect(readFileSync(join(shared.path, "a.txt"), "utf8")).toBe("a\n");
    expect(readFileSync(join(shared.path, "b.txt"), "utf8")).toBe("b\n");
    expect(log(shared.path)).toContain("Navarch Merge team member b");
    expect(await mergeBranch({ repoPath, target: shared, source: a, message: "again" })).toEqual({ merged: true });
  });

  it("leaves a conflicting merge in progress, then concludes it once the markers are gone", async () => {
    const { repoPath, shared, fork } = await setup();
    const a = await fork("a");
    const b = await fork("b");
    writeFileSync(join(a.path, "README.md"), "# from a\n");
    writeFileSync(join(b.path, "README.md"), "# from b\n");
    await mergeBranch({ repoPath, target: shared, source: a, message: "Merge a" });
    expect(await mergeBranch({ repoPath, target: shared, source: b, message: "Merge b" })).toEqual({ merged: false, conflicts: ["README.md"] });
    expect(readFileSync(join(shared.path, "README.md"), "utf8")).toContain("<<<<<<<");

    writeFileSync(join(shared.path, "README.md"), "# from a and b\n");
    expect(await concludeMerge({ repoPath, target: shared, source: b, files: ["README.md"] })).toEqual({ merged: true });
    expect(log(shared.path)).toMatch(/^Navarch Merge b/);
  });

  it("forks from before a merge that waits for its conflicts, without committing it", async () => {
    const { repoPath, shared, fork } = await setup();
    const a = await fork("a");
    const b = await fork("b");
    writeFileSync(join(a.path, "README.md"), "# from a\n");
    writeFileSync(join(b.path, "README.md"), "# from b\n");
    await mergeBranch({ repoPath, target: shared, source: a, message: "Merge a" });
    await mergeBranch({ repoPath, target: shared, source: b, message: "Merge b" });
    const before = head(shared.path);
    const c = await fork("c");
    expect(c.baseCommit).toBe(before);
    expect(head(shared.path)).toBe(before);
    expect(readFileSync(join(c.path, "README.md"), "utf8")).toBe("# from a\n");
  });

  it("aborts a merge whose markers are still there", async () => {
    const { repoPath, shared, fork } = await setup();
    const a = await fork("a");
    const b = await fork("b");
    writeFileSync(join(a.path, "README.md"), "# from a\n");
    writeFileSync(join(b.path, "README.md"), "# from b\n");
    await mergeBranch({ repoPath, target: shared, source: a, message: "Merge a" });
    await mergeBranch({ repoPath, target: shared, source: b, message: "Merge b" });
    expect(await concludeMerge({ repoPath, target: shared, source: b, files: ["README.md"] })).toEqual({ merged: false, conflicts: ["README.md"] });
    expect(readFileSync(join(shared.path, "README.md"), "utf8")).toBe("# from a\n");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: shared.path, encoding: "utf8" })).toBe("");
  });
});
