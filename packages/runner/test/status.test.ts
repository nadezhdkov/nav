import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { worktreeFileDiff, worktreeStatus } from "../src/index.ts";
import { makeRepo } from "./helpers.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, env }).toString();

/** A repository with a base commit, then every kind of change on top of it. */
function changedRepo(): { dir: string; base: string } {
  const dir = makeRepo();
  writeFileSync(join(dir, "keep.ts"), "one\ntwo\nthree\n");
  writeFileSync(join(dir, "gone.ts"), "a\nb\n");
  writeFileSync(join(dir, "old-name.ts"), "same content line 1\nsame content line 2\nsame content line 3\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD").trim();

  writeFileSync(join(dir, "keep.ts"), "one\nTWO\nthree\nfour\n");
  rmSync(join(dir, "gone.ts"));
  renameSync(join(dir, "old-name.ts"), join(dir, "new-name.ts"));
  writeFileSync(join(dir, "committed.ts"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "agent work");
  writeFileSync(join(dir, "staged.ts"), "s1\ns2\n");
  git(dir, "add", "staged.ts");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "fresh.ts"), "f1\nf2\nf3\n");
  writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
  writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
  writeFileSync(join(dir, "ignored.log"), "noise\n");
  return { dir, base };
}

describe("worktree status (slice 10)", () => {
  it.skipIf(process.platform === "win32")("does not block on a named pipe among the untracked files", async () => {
    const { dir, base } = changedRepo();
    execFileSync("mkfifo", [join(dir, "pipe")]);
    const status = await worktreeStatus(dir, base);
    // Whether or not git lists it, the status comes back, and a pipe is never counted as text.
    const pipe = status.files.find((f) => f.path === "pipe");
    if (pipe) expect(pipe).toMatchObject({ added: null, removed: null });
    expect(status.files.find((f) => f.path === "src/fresh.ts")).toMatchObject({ added: 3 });
  });

  it("lists every change since the base commit with line counts and totals", async () => {
    const { dir, base } = changedRepo();
    const status = await worktreeStatus(dir, base);
    const byPath = new Map(status.files.map((f) => [f.path, f]));
    expect(byPath.get("keep.ts")).toEqual({ path: "keep.ts", status: "modified", added: 2, removed: 1 });
    expect(byPath.get("gone.ts")).toEqual({ path: "gone.ts", status: "deleted", added: 0, removed: 2 });
    expect(byPath.get("new-name.ts")).toEqual({ path: "new-name.ts", old_path: "old-name.ts", status: "renamed", added: 0, removed: 0 });
    expect(byPath.get("committed.ts")).toMatchObject({ status: "added", added: 1, removed: 0 });
    expect(byPath.get("staged.ts")).toMatchObject({ status: "added", added: 2 });
    expect(byPath.get("src/fresh.ts")).toEqual({ path: "src/fresh.ts", status: "untracked", added: 3, removed: 0 });
    expect(byPath.get("logo.png")).toEqual({ path: "logo.png", status: "untracked", added: null, removed: null });
    expect(byPath.has("ignored.log")).toBe(false);
    expect(byPath.get(".gitignore")).toMatchObject({ status: "untracked", added: 1 });
    expect(status.totals).toEqual({
      files: status.files.length,
      added: status.files.reduce((n, f) => n + (f.added ?? 0), 0),
      removed: status.files.reduce((n, f) => n + (f.removed ?? 0), 0),
    });
  });

  it("leaves the index and the files untouched", async () => {
    const { dir, base } = changedRepo();
    const before = { status: git(dir, "status", "--porcelain=v2"), cached: git(dir, "diff", "--cached", "--name-only") };
    await worktreeStatus(dir, base);
    for (const f of (await worktreeStatus(dir, base)).files) await worktreeFileDiff(dir, base, f);
    expect({ status: git(dir, "status", "--porcelain=v2"), cached: git(dir, "diff", "--cached", "--name-only") }).toEqual(before);
    expect(before.cached.trim()).toBe("staged.ts");
  });

  it("shows one file's diff, for tracked, renamed and untracked files", async () => {
    const { dir, base } = changedRepo();
    const files = new Map((await worktreeStatus(dir, base)).files.map((f) => [f.path, f]));
    expect(await worktreeFileDiff(dir, base, files.get("keep.ts")!)).toContain("+TWO");
    expect(await worktreeFileDiff(dir, base, files.get("new-name.ts")!)).toContain("rename from old-name.ts");
    const fresh = await worktreeFileDiff(dir, base, files.get("src/fresh.ts")!);
    expect(fresh).toContain("+f3");
    expect(fresh).not.toContain(dir);
  });

  it("truncates a long diff with a marker", async () => {
    const { dir, base } = changedRepo();
    writeFileSync(join(dir, "big.txt"), "line of text\n".repeat(2_000));
    const big = (await worktreeStatus(dir, base)).files.find((f) => f.path === "big.txt")!;
    const diff = await worktreeFileDiff(dir, base, big, 1_024);
    expect(Buffer.byteLength(diff)).toBeLessThan(1_200);
    expect(diff).toMatch(/truncated/);
  });
});
