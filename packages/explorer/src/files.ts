import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const MAX_FILES = 20_000;
export const MAX_FILE_BYTES = 512 * 1024;

/** Files git knows or would add (so `.gitignore` is respected), sorted, capped. */
export async function listFiles(root: string): Promise<string[]> {
  const { stdout } = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(stdout.split("\0").filter(Boolean))].sort().slice(0, MAX_FILES);
}

/** The file's text, or undefined when it is missing, too large or binary. */
export async function readText(root: string, rel: string): Promise<string | undefined> {
  let handle;
  try {
    // Stat and read the same descriptor, so the file cannot change between the check and the read.
    handle = await open(join(root, rel), "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
    const text = await handle.readFile("utf8");
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/** Identifies the tree's state: HEAD plus the status, so edits invalidate a cached index. */
export async function treeKey(root: string): Promise<string> {
  const git = async (...args: string[]) => {
    try {
      return (await run("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout;
    } catch {
      return "";
    }
  };
  const [head, status] = await Promise.all([git("rev-parse", "HEAD"), git("status", "--porcelain=v1", "-z")]);
  return `${head.trim()}:${createHash("sha1").update(status).digest("hex")}`;
}
