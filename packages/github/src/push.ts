import { execFile } from "node:child_process";
import { join } from "node:path";
import { redact } from "@vectr/contracts";

/** Branches VECTR may write (spec §6.7.4): `vectr/` plus safe path segments, nothing else. */
const VECTR_BRANCH = /^vectr(\/[A-Za-z0-9_][A-Za-z0-9._-]*)+$/;

export function isVectrBranch(branch: string): boolean {
  return VECTR_BRANCH.test(branch) && !branch.split("/").some((part) => part === ".." || part.endsWith(".lock"));
}

/** `owner/name` of a GitHub remote URL (https, ssh or scp form), or undefined for anything else. */
export function repoFromRemote(url: string): string | undefined {
  const m = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m?.[1];
}

export type PushSpec = {
  /** Repository (or worktree) holding the branch. */
  repoPath: string;
  /** `owner/name` on GitHub. */
  repo: string;
  branch: string;
  token: string;
  /** Base for clone URLs, `https://github.com` by default; tests use a local directory of bare repositories. */
  gitUrl?: string;
};

/**
 * Pushes one `vectr/*` branch to GitHub and returns the pushed commit. The URL is built from the
 * repository name, not read from `origin`, so the operator's SSH keys and credential helpers are
 * never used. The token reaches git for this one command through `GIT_CONFIG_*` (ADR 0007), and
 * the refspec has no `+`: a branch that moved on GitHub is not overwritten.
 */
export async function pushBranch(spec: PushSpec): Promise<string> {
  if (!isVectrBranch(spec.branch)) throw new Error(`refusing to push ${JSON.stringify(spec.branch)}: only vectr/* branches`);
  const base = spec.gitUrl ?? "https://github.com";
  const url = /^https?:\/\//.test(base) ? `${base.replace(/\/$/, "")}/${spec.repo}.git` : join(base, `${spec.repo}.git`);
  const ref = `refs/heads/${spec.branch}`;
  const commit = (await git(spec.repoPath, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  const basic = Buffer.from(`x-access-token:${spec.token}`).toString("base64");
  try {
    await git(spec.repoPath, ["push", "--porcelain", url, `${ref}:${ref}`], {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.extraheader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
    });
  } catch (err) {
    throw new Error(redact(`push failed for ${spec.branch}: ${err instanceof Error ? err.message : String(err)}`).replaceAll(basic, "[REDACTED]"));
  }
  return commit;
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: { ...process.env, ...env }, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout);
    });
  });
}
