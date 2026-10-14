import { execFile } from "node:child_process";

export class GitError extends Error {
  readonly args: string[];
  readonly stderr: string;

  constructor(args: string[], stderr: string) {
    super(`git ${args.join(" ")} failed: ${stderr.trim()}`);
    this.args = args;
    this.stderr = stderr;
  }
}

/** Runs git with an argument array (never a shell string) and returns stdout. */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new GitError(args, stderr || err.message));
      else resolve(stdout);
    });
  });
}
