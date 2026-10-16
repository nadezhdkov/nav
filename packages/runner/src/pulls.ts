import { git } from "./git.ts";

/** How much of a pull request's diff a run prompt carries (ADR 0032). */
export const PR_DIFF_CAP = 40_000;

/**
 * A pull request's change as `git diff base...head` shows it (from the merge base), with its
 * `--stat`, cut at `cap` characters. Read from the clone, where the run fetched both commits.
 */
export async function pullRequestDiff(repoPath: string, base: string, head: string, cap = PR_DIFF_CAP): Promise<{ stat: string; diff: string; truncated: boolean }> {
  const range = `${base}...${head}`;
  const stat = (await git(repoPath, ["diff", "--no-color", "--no-ext-diff", "--stat=120", range])).trimEnd();
  const full = await git(repoPath, ["diff", "--no-color", "--no-ext-diff", range]);
  return { stat, diff: full.length > cap ? full.slice(0, cap) : full, truncated: full.length > cap };
}

/** The whole diff, for placing review comments; never sent to an agent. */
export async function fullPullRequestDiff(repoPath: string, base: string, head: string): Promise<string> {
  return git(repoPath, ["diff", "--no-color", "--no-ext-diff", `${base}...${head}`]);
}

/**
 * The lines of each file's new version that a unified diff shows (added or context lines), which
 * are the only lines GitHub accepts review comments on (side `RIGHT`).
 */
export function diffRightLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: Set<number> | undefined;
  let line = 0;
  for (const text of diff.split("\n")) {
    if (text.startsWith("diff --git ")) {
      file = undefined;
      continue;
    }
    if (text.startsWith("+++ ")) {
      const path = text.slice(4).replace(/^b\//, "");
      file = path === "/dev/null" ? undefined : (out.get(path) ?? new Set());
      if (file) out.set(path, file);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file || text.startsWith("--- ") || text.startsWith("\\")) continue;
    if (text.startsWith("+") || text.startsWith(" ")) file.add(line++);
  }
  return out;
}
