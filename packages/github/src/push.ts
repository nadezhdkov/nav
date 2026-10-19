import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_PATTERN, redact } from "@navarch/contracts";

/** Branches Navarch may write (spec §6.7.4): `navarch/` plus safe path segments, nothing else. */
const NAVARCH_BRANCH = /^navarch(\/[A-Za-z0-9_][A-Za-z0-9._-]*)+$/;

export function isNavarchBranch(branch: string): boolean {
  return NAVARCH_BRANCH.test(branch) && !branch.split("/").some((part) => part === ".." || part.endsWith(".lock"));
}

/** `owner/name` of a GitHub remote URL (https, ssh or scp form), or undefined for anything else. */
export function repoFromRemote(url: string): string | undefined {
  const m = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)(.+?)(?:\.git)?\/?$/.exec(url.trim());
  return m?.[1] && new RegExp(`^${REPO_PATTERN}$`).test(m[1]) ? m[1] : undefined;
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
 * Pushes one `navarch/*` branch to GitHub and returns the pushed commit. The URL is built from the
 * repository name, not read from `origin`, so the operator's SSH keys and credential helpers are
 * never used. The token reaches git for this one command through `GIT_CONFIG_*` (ADR 0007), and
 * the refspec has no `+`: a branch that moved on GitHub is not overwritten.
 */
export async function pushBranch(spec: PushSpec): Promise<string> {
  if (!isNavarchBranch(spec.branch)) throw new Error(`refusing to push ${JSON.stringify(spec.branch)}: only navarch/* branches`);
  const remote = remoteFor(spec.repo, spec.gitUrl);
  const ref = `refs/heads/${spec.branch}`;
  const commit = (await git(spec.repoPath, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  try {
    // --no-verify: repository hooks would run as the operator and see the token in the environment.
    await git(spec.repoPath, ["push", "--no-verify", "--porcelain", remote.url, `${ref}:${ref}`], remote.auth(spec.token));
  } catch (err) {
    throw remote.failure(`push failed for ${spec.branch}`, err, spec.token);
  }
  return commit;
}

/** The branch a push check names; nothing is ever written to it. */
const CHECK_BRANCH = "refs/heads/navarch/push-check";

/**
 * Checks that the token may push to `repo`, without writing anything: `git push --dry-run` asks
 * GitHub for the push side of the repository, which it refuses (403, or "not found" for a private
 * repository) when the token has no write access. Throws with git's message when it may not.
 */
export async function checkPush(spec: { repoPath: string; repo: string; token: string; gitUrl?: string }): Promise<void> {
  const remote = remoteFor(spec.repo, spec.gitUrl);
  try {
    await git(spec.repoPath, ["push", "--dry-run", "--no-verify", "--porcelain", remote.url, `HEAD:${CHECK_BRANCH}`], remote.auth(spec.token));
  } catch (err) {
    throw remote.failure(`cannot push to ${spec.repo}`, err, spec.token);
  }
}

/**
 * Clones a GitHub repository into `dest` for a managed project (ADR 0026), with the token for this
 * one command as for a push. The clone's `origin` is the plain GitHub URL, with no credentials, so
 * later reads of it (`repoOf`) work and nothing secret stays in its config. Hooks never run: a fresh
 * clone has none, and checkout hooks come only from the operator's templates, which are disabled.
 */
export async function cloneRepo(spec: { repo: string; dest: string; token: string; gitUrl?: string }): Promise<void> {
  const remote = remoteFor(spec.repo, spec.gitUrl);
  if (existsSync(spec.dest)) throw new Error(`${spec.dest} already exists`);
  mkdirSync(dirname(spec.dest), { recursive: true });
  try {
    await git(dirname(spec.dest), ["clone", "-q", "--template=", remote.url, spec.dest], remote.auth(spec.token));
  } catch (err) {
    rmSync(spec.dest, { recursive: true, force: true });
    throw remote.failure(`clone of ${spec.repo} failed`, err, spec.token);
  }
  await git(spec.dest, ["remote", "set-url", "origin", `https://github.com/${spec.repo}.git`]);
}

/** Where a run on a pull request keeps its head and base in the clone (ADR 0032). */
export const pullRequestRefs = (number: number) => ({ head: `refs/navarch/pr/${number}/head`, base: `refs/navarch/pr/${number}/base` });

/**
 * Fetches a pull request's head (`refs/pull/<N>/head`, which works for forks too) and its base
 * branch into `refs/navarch/pr/<N>/*` of the clone, and returns both commits. Branches and tags are
 * left alone; the token reaches git for this one command, and no hook runs.
 */
export async function fetchPullRequest(spec: { repoPath: string; repo: string; number: number; baseRef: string; token: string; gitUrl?: string }): Promise<{ head: string; base: string }> {
  if (!Number.isInteger(spec.number) || spec.number < 1) throw new Error(`invalid pull request number ${spec.number}`);
  await git(spec.repoPath, ["check-ref-format", `refs/heads/${spec.baseRef}`]).catch(() => {
    throw new Error(`invalid base branch ${JSON.stringify(spec.baseRef)}`);
  });
  const remote = remoteFor(spec.repo, spec.gitUrl);
  const refs = pullRequestRefs(spec.number);
  try {
    await git(
      spec.repoPath,
      ["-c", "core.hooksPath=/dev/null", "fetch", "-q", "--no-tags", "--no-write-fetch-head", remote.url, `+refs/pull/${spec.number}/head:${refs.head}`, `+refs/heads/${spec.baseRef}:${refs.base}`],
      remote.auth(spec.token),
    );
  } catch (err) {
    throw remote.failure(`fetch of ${spec.repo}#${spec.number} failed`, err, spec.token);
  }
  const head = (await git(spec.repoPath, ["rev-parse", "--verify", `${refs.head}^{commit}`])).trim();
  const base = (await git(spec.repoPath, ["rev-parse", "--verify", `${refs.base}^{commit}`])).trim();
  return { head, base };
}

/**
 * Fetches the base branch of a pull request that was merged into `refs/navarch/pr/<N>/base` and
 * checks that its merge commit is still on it (ADR 0049). Returns the merge commit and its first
 * parent, so the diff between them is what the pull request brought in, for merge, squash and
 * rebase merges alike. Branches and tags are left alone; no hook runs.
 */
export async function fetchMergedPullRequest(spec: { repoPath: string; repo: string; number: number; baseRef: string; mergeCommit: string; token: string; gitUrl?: string }): Promise<{ merge: string; parent: string }> {
  if (!Number.isInteger(spec.number) || spec.number < 1) throw new Error(`invalid pull request number ${spec.number}`);
  if (!/^[0-9a-f]{40}$/.test(spec.mergeCommit)) throw new Error(`invalid merge commit ${JSON.stringify(spec.mergeCommit)}`);
  await git(spec.repoPath, ["check-ref-format", `refs/heads/${spec.baseRef}`]).catch(() => {
    throw new Error(`invalid base branch ${JSON.stringify(spec.baseRef)}`);
  });
  const remote = remoteFor(spec.repo, spec.gitUrl);
  const ref = pullRequestRefs(spec.number).base;
  try {
    await git(spec.repoPath, ["-c", "core.hooksPath=/dev/null", "fetch", "-q", "--no-tags", "--no-write-fetch-head", remote.url, `+refs/heads/${spec.baseRef}:${ref}`], remote.auth(spec.token));
  } catch (err) {
    throw remote.failure(`fetch of ${spec.repo}#${spec.number} failed`, err, spec.token);
  }
  const merge = (await git(spec.repoPath, ["rev-parse", "--verify", `${spec.mergeCommit}^{commit}`]).catch(() => "")).trim();
  const onBase = merge ? await git(spec.repoPath, ["merge-base", "--is-ancestor", merge, ref]).then(() => true, () => false) : false;
  if (!onBase) throw new Error(`the merge commit ${spec.mergeCommit.slice(0, 7)} of ${spec.repo}#${spec.number} is not on ${spec.baseRef} any more`);
  const parent = (await git(spec.repoPath, ["rev-parse", "--verify", `${merge}^1`]).catch(() => "")).trim();
  if (!parent) throw new Error(`the merge commit ${merge.slice(0, 7)} has no parent to compare with`);
  return { merge, parent };
}

/**
 * The URL a repository is reached at (from the repository name, never from `origin`, so the
 * operator's SSH keys and credential helpers are never used) and the `GIT_CONFIG_*` environment that
 * hands git the token for one command (ADR 0007), scoped to the GitHub URL.
 */
function remoteFor(repo: string, gitUrl = "https://github.com") {
  if (!new RegExp(`^${REPO_PATTERN}$`).test(repo)) throw new Error(`invalid repository name ${JSON.stringify(repo)}`);
  const web = /^https?:\/\//.test(gitUrl) ? gitUrl.replace(/\/$/, "") : undefined;
  const basic = (token: string) => Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    url: web ? `${web}/${repo}.git` : join(gitUrl, `${repo}.git`),
    auth: (token: string): Record<string, string> => ({
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      // Scoped to the GitHub URL, so the header is not sent to any other host.
      GIT_CONFIG_KEY_0: web ? `http.${web}/.extraheader` : "http.extraheader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic(token)}`,
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
    }),
    failure: (what: string, err: unknown, token: string) =>
      new Error(redact(`${what}: ${err instanceof Error ? err.message : String(err)}`).replaceAll(basic(token), "[REDACTED]")),
  };
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: { ...process.env, ...env }, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout);
    });
  });
}
