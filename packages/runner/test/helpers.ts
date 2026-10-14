import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Creates a throwaway git repository with one commit. */
export function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "vectr-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# test repo\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "vectr-home-"));
}
