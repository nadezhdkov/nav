import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffRightLines, pullRequestDiff } from "../src/index.ts";
import { makeRepo } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } }).trim();

describe("pullRequestDiff (ADR 0032)", () => {
  it("diffs from the merge base and cuts the text at the cap", async () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "switch", "-q", "-c", "feature");
    writeFileSync(join(repo, "new.txt"), "a\n".repeat(100));
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "feature");
    const head = git(repo, "rev-parse", "HEAD");
    // A later commit on main is not part of the pull request's change.
    git(repo, "switch", "-q", "main");
    writeFileSync(join(repo, "main-only.txt"), "m\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "main");
    const tip = git(repo, "rev-parse", "HEAD");
    expect(base).not.toBe(tip);

    const full = await pullRequestDiff(repo, tip, head);
    expect(full.stat).toContain("new.txt");
    expect(full.diff).not.toContain("main-only.txt");
    expect(full.truncated).toBe(false);
    const cut = await pullRequestDiff(repo, tip, head, 50);
    expect(cut).toMatchObject({ truncated: true });
    expect(cut.diff).toHaveLength(50);
  });
});

describe("diffRightLines", () => {
  it("lists the new-side lines a diff shows, per file", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,4 @@",
      " one",
      "-two",
      "+deux",
      "+trois",
      " four",
      "@@ -10,2 +11,2 @@",
      " ten",
      "+eleven",
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "\\ No newline at end of file",
    ].join("\n");
    const lines = diffRightLines(diff);
    expect([...lines.get("a.ts")!]).toEqual([1, 2, 3, 4, 11, 12]);
    expect(lines.has("gone.ts")).toBe(false);
  });
});
