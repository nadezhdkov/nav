import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedFiles, createWorktree, removeWorktree, resolveHead, worktreeDiff } from "../src/index.ts";
import { makeRepo, tempHome } from "./helpers.ts";

describe("worktrees", () => {
  it("creates vectr/<run>/<task> under <home>/worktrees, reuses it, and diffs against the base", async () => {
    const repo = makeRepo();
    const home = tempHome();
    const base = await resolveHead(repo);
    const spec = { sandboxId: "sbx_1", repoPath: repo, runId: "run_1", taskSlug: "implement", baseCommit: base, home };

    const first = await createWorktree(spec);
    expect(first.reused).toBe(false);
    expect(first.branch).toBe("vectr/run_1/implement");
    expect(first.path.startsWith(join(home, "worktrees"))).toBe(true);
    expect(existsSync(join(first.path, "README.md"))).toBe(true);

    writeFileSync(join(first.path, "new.txt"), "new\n");
    writeFileSync(join(first.path, "README.md"), "# changed\n");

    const again = await createWorktree(spec);
    expect(again.reused).toBe(true);
    expect(await changedFiles(again)).toEqual(["README.md", "new.txt"]);
    const diff = await worktreeDiff(again);
    expect(diff).toContain("+new");
    expect(diff).toContain("+# changed");

    await removeWorktree(repo, again);
    expect(existsSync(first.path)).toBe(false);
  });
});
