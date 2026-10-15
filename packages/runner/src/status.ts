import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorktreeFile } from "@navarch/contracts";
import { GitError } from "./git.ts";

/** Untracked text files up to this size have their lines counted (slice 10). */
const UNTRACKED_COUNT_LIMIT = 1024 * 1024;
export const DIFF_LIMIT = 512 * 1024;

/**
 * Runs git read-only: no optional locks, so not even an index stat refresh is written while the
 * agent works in the same worktree. Exit code 1 is a result for `diff --no-index`.
 */
function readGit(cwd: string, args: string[], okCodes: number[] = [0]): Promise<string> {
  const all = ["-c", "core.quotePath=false", ...args];
  return new Promise((resolve, reject) => {
    execFile("git", all, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      if (okCodes.includes(code)) resolve(stdout);
      else reject(new GitError(all, stderr || String(err?.message)));
    });
  });
}

const STATUS: Record<string, WorktreeFile["status"]> = { A: "added", M: "modified", T: "modified", D: "deleted", R: "renamed" };

/**
 * Files changed in a worktree since `base` (committed, staged or not) plus untracked files, with
 * `+added −removed` lines (null for binary files), read without touching the index or the files.
 */
export async function worktreeStatus(dir: string, base: string): Promise<{ files: WorktreeFile[]; totals: { files: number; added: number; removed: number } }> {
  const [names, numstat, untracked] = await Promise.all([
    readGit(dir, ["diff", "--name-status", "-z", "-M", base, "--"]),
    readGit(dir, ["diff", "--numstat", "-z", "-M", base, "--"]),
    readGit(dir, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);

  const counts = new Map<string, { added: number | null; removed: number | null }>();
  const n = numstat.split("\0");
  for (let i = 0; i < n.length - 1; ) {
    const [added, removed, path] = n[i]!.split("\t");
    // A rename is `added\tremoved\t` followed by the old and new paths as their own fields.
    const target = path === "" ? n[(i += 2)]! : path!;
    counts.set(target, { added: added === "-" ? null : Number(added), removed: removed === "-" ? null : Number(removed) });
    i++;
  }

  const files: WorktreeFile[] = [];
  const f = names.split("\0");
  for (let i = 0; i < f.length - 1; ) {
    const code = f[i]!.charAt(0);
    if (code === "R" || code === "C") {
      const [oldPath, path] = [f[i + 1]!, f[i + 2]!];
      files.push({ path, ...(code === "R" ? { old_path: oldPath, status: "renamed" as const } : { status: "added" as const }), ...(counts.get(path) ?? { added: null, removed: null }) });
      i += 3;
    } else {
      const path = f[i + 1]!;
      files.push({ path, status: STATUS[code] ?? "modified", ...(counts.get(path) ?? { added: null, removed: null }) });
      i += 2;
    }
  }

  for (const path of untracked.split("\0").filter(Boolean)) {
    files.push({ path, status: "untracked", ...(await untrackedLines(join(dir, path))) });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    totals: { files: files.length, added: files.reduce((s, x) => s + (x.added ?? 0), 0), removed: files.reduce((s, x) => s + (x.removed ?? 0), 0) },
  };
}

/** Lines of an untracked text file up to 1 MiB; null for binary or larger files. */
async function untrackedLines(path: string): Promise<{ added: number | null; removed: number | null }> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size > UNTRACKED_COUNT_LIMIT) return { added: null, removed: null };
  const handle = await open(path, "r");
  try {
    const buffer = await handle.readFile();
    if (buffer.subarray(0, 8000).includes(0)) return { added: null, removed: null };
    const text = buffer.toString("utf8");
    const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return { added: lines, removed: 0 };
  } finally {
    await handle.close();
  }
}

/**
 * One file's diff against `base`, cut at `limit` bytes with a marker. The file must come from
 * `worktreeStatus`; its paths are passed after `--` and nothing else from a request reaches git.
 */
export async function worktreeFileDiff(dir: string, base: string, file: WorktreeFile, limit = DIFF_LIMIT): Promise<string> {
  const text =
    file.status === "untracked"
      ? await readGit(dir, ["diff", "--no-index", "--", "/dev/null", file.path], [0, 1])
      : await readGit(dir, ["diff", "-M", base, "--", ...(file.old_path ? [file.old_path] : []), file.path]);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  return `${bytes.subarray(0, limit).toString("utf8")}\n… diff truncated at ${Math.round(limit / 1024)} KiB of ${Math.round(bytes.length / 1024)} KiB\n`;
}
