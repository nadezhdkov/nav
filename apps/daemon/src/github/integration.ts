import { parseIssueRef, type Actor, type WorkItem } from "@navarch/contracts";
import { checkPush, cloneRepo, fetchMergedPullRequest, fetchPullRequest, GitHubClient, pushBranch, repoFromRemote, type CheckStatus, type GitHubRepo, type OpenPullRequest } from "@navarch/github";
import { remoteUrl } from "@navarch/runner";
import type { Config } from "../config.ts";
import type { PolicyEngine } from "../policy/engine.ts";
import type { Vault } from "../vault/vault.ts";

export class GitHubIntegrationError extends Error {
  readonly code: "invalid_issue" | "repo_mismatch" | "policy_denied" | "push_denied" | "pr_closed" | "pr_not_merged" | "github_error";

  constructor(code: GitHubIntegrationError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const integration: Actor = { kind: "system", component: "github" };
const autoMerger: Actor = { kind: "system", component: "automerge" };
/** How long a repository listing is reused, so opening New run twice costs one request. */
const REPOS_TTL_MS = 60_000;

/**
 * GitHub Integration (spec §6.7): the only module that talks to GitHub. Its token comes from the
 * Vault on each use (ADR 0007), and every write is decided by the Policy Engine first.
 */
export class GitHubIntegration {
  readonly client: GitHubClient;
  private readonly config: Config;
  private readonly vault: Vault;
  private readonly policy: PolicyEngine;
  private repos?: { at: number; list: GitHubRepo[] };

  constructor(config: Config, vault: Vault, policy: PolicyEngine) {
    this.config = config;
    this.vault = vault;
    this.policy = policy;
    this.client = new GitHubClient({ apiUrl: config.github.api_url, token: () => vault.get("github/token") });
  }

  /** `owner/repo` of the clone's `origin`, which must be on GitHub. */
  async repoOf(repoPath: string): Promise<string | undefined> {
    const url = await remoteUrl(repoPath);
    return url ? repoFromRemote(url) : undefined;
  }

  /** Reads `owner/repo#N`, refusing an issue that does not belong to the clone's origin. */
  async readIssue(repoPath: string, ref: string): Promise<WorkItem> {
    const { origin, number } = await this.originRef(repoPath, ref);
    return this.client.getIssue(origin, number);
  }

  /**
   * Reads an open pull request of the clone's origin, fetches its head and base into
   * `refs/navarch/pr/<N>/*` and lists its failing checks (ADR 0032). Reading writes nothing on
   * GitHub, so it needs no policy decision; the token reaches git for the one fetch.
   */
  async readPullRequest(repoPath: string, ref: string): Promise<WorkItem & { pull_request: NonNullable<WorkItem["pull_request"]> }> {
    const { origin, number } = await this.originRef(repoPath, ref);
    const { state, head_ref, head_sha, head_repo, base_ref, base_sha, draft, merged: _merged, merge_commit_sha: _merge, ...item } = await this.client.getPullRequest(origin, number);
    if (state !== "open") throw new GitHubIntegrationError("pr_closed", `${origin}#${number} is closed; Navarch works on open pull requests`);
    const token = await this.vault.get("github/token");
    const fetched = await fetchPullRequest({ repoPath, repo: origin, number, baseRef: base_ref, token, gitUrl: this.config.github.git_url });
    // What was fetched is what the run works on, even if the pull request moved since it was read.
    const failing_checks = await this.client.failingChecks(origin, fetched.head);
    return { ...item, pull_request: { head_ref, head_sha: fetched.head, head_repo, base_ref, base_sha: fetched.base, draft, failing_checks } };
  }

  /**
   * A pull request that was merged, for `spec-sync` (ADR 0049): the work item with its pull request
   * set to what the merge changed. Its `head_sha` is the merge commit, which the run works on, and
   * its `base_sha` the merge commit's first parent, so the prompt's diff is what the merge brought in.
   */
  async readMergedPullRequest(repoPath: string, ref: string): Promise<WorkItem & { pull_request: NonNullable<WorkItem["pull_request"]> }> {
    const { origin, number } = await this.originRef(repoPath, ref);
    const { state, head_ref, head_sha: _head, head_repo, base_ref, base_sha: _base, draft, merged, merge_commit_sha, ...item } = await this.client.getPullRequest(origin, number);
    if (state === "open" || !merged || !merge_commit_sha) throw new GitHubIntegrationError("pr_not_merged", `${origin}#${number} is not merged; spec-sync works on merged pull requests`);
    const token = await this.vault.get("github/token");
    let fetched;
    try {
      fetched = await fetchMergedPullRequest({ repoPath, repo: origin, number, baseRef: base_ref, mergeCommit: merge_commit_sha, token, gitUrl: this.config.github.git_url });
    } catch (err) {
      throw new GitHubIntegrationError("github_error", (err as Error).message);
    }
    return { ...item, pull_request: { head_ref, head_sha: fetched.merge, head_repo, base_ref, base_sha: fetched.parent, draft, failing_checks: [] } };
  }

  /**
   * What became of a pull request Navarch opened (ADR 0037): undefined while it is open, else how it
   * closed and how many commits its head has after `commit`, Navarch's last push. A compare GitHub
   * cannot make gives null. Reads only.
   */
  async pullRequestOutcome(repo: string, number: number, commit: string | null): Promise<{ merged: boolean; closed_at: string; head_sha: string; commits_after: number | null } | undefined> {
    const pr = await this.client.pullRequestState(repo, number);
    if (pr.state === "open") return undefined;
    let commits_after: number | null = null;
    if (commit) {
      commits_after = commit === pr.head_sha ? 0 : await this.client.commitsAhead(repo, commit, pr.head_sha).catch(() => null);
    }
    return { merged: pr.merged, closed_at: pr.closed_at ?? new Date().toISOString(), head_sha: pr.head_sha, commits_after };
  }

  /** The open pull requests of a repository, for the CI watcher (ADR 0041). Reads only. */
  listOpenPullRequests(repo: string): Promise<OpenPullRequest[]> {
    return this.client.listOpenPullRequests(repo);
  }

  /** What auto-merge checks on GitHub before a merge (ADR 0060). Reads only. */
  async mergeFacts(repo: string, number: number): Promise<MergeFacts> {
    const pr = await this.client.pullRequestForMerge(repo, number);
    const [base_protected, files, checks] = await Promise.all([
      this.client.branchProtected(repo, pr.base_ref),
      this.client.pullRequestFiles(repo, number),
      this.client.checksOverview(repo, pr.head_sha),
    ]);
    return { ...pr, default_branch: await this.client.defaultBranch(repo), base_protected, files: files.files, files_truncated: files.truncated, checks };
  }

  /**
   * Merges a pull request of Navarch's under auto-merge, after the Policy Engine allowed it. A draft
   * is marked ready first and turned back into a draft if the merge fails. GitHub merges only when
   * the head is still `sha`.
   */
  async autoMerge(pr: { repo: string; number: number; sha: string; node_id: string; draft: boolean; title: string; method: "squash" | "merge" | "rebase" }, context: { autonomyLevel: number; enabled: boolean }): Promise<{ sha: string | null }> {
    const decision = this.policy.decide(autoMerger, "github.pr.merge", `${pr.repo}#${pr.number}`, { autonomyLevel: context.autonomyLevel, autoMerge: { enabled: context.enabled } });
    if (decision.effect !== "allow") throw new GitHubIntegrationError("policy_denied", `merge of ${pr.repo}#${pr.number} denied: ${decision.reason}`);
    if (pr.draft) await this.client.markReady(pr.node_id);
    try {
      return await this.client.mergePullRequest(pr.repo, pr.number, { sha: pr.sha, method: pr.method, title: pr.title });
    } catch (err) {
      if (pr.draft) await this.client.convertToDraft(pr.node_id).catch(() => {});
      throw err;
    }
  }

  /** How a commit's check runs stand, without their logs (ADR 0041). Reads only. */
  checkStatus(repo: string, sha: string): Promise<CheckStatus> {
    return this.client.checkStatus(repo, sha);
  }

  /** Posts a COMMENT review, or returns the one this run already posted (its body holds `marker`). */
  async postReview(review: { repo: string; number: number; commit_id: string; body: string; comments: { path: string; line: number; body: string }[]; marker: string }): Promise<{ url: string; existing: boolean }> {
    const found = (await this.client.listReviews(review.repo, review.number)).find((r) => r.body.includes(review.marker));
    if (found) return { url: found.url, existing: true };
    const { marker: _marker, ...rest } = review;
    return { url: (await this.client.createReview(rest)).url, existing: false };
  }

  /** Posts a comment, or returns the one this run already posted (its body holds `marker`). */
  async postComment(comment: { repo: string; number: number; body: string; marker: string }): Promise<{ url: string; existing: boolean }> {
    const found = (await this.client.listComments(comment.repo, comment.number)).find((c) => c.body.includes(comment.marker));
    if (found) return { url: found.url, existing: true };
    return { url: (await this.client.createComment(comment.repo, comment.number, comment.body)).url, existing: false };
  }

  /** `owner/repo#N` of the clone's origin; any other repository is refused. */
  private async originRef(repoPath: string, ref: string): Promise<{ origin: string; number: number }> {
    const parsed = parseIssueRef(ref);
    if (!parsed) throw new GitHubIntegrationError("invalid_issue", `expected owner/repo#number, got ${JSON.stringify(ref)}`);
    const origin = await this.repoOf(repoPath);
    if (!origin || origin.toLowerCase() !== parsed.repo.toLowerCase()) {
      throw new GitHubIntegrationError(
        "repo_mismatch",
        `${repoPath} has origin ${origin ?? "(none on GitHub)"}, so it cannot work on ${parsed.repo}#${parsed.number}`,
      );
    }
    return { origin, number: parsed.number };
  }

  /** The repositories the token reaches (ADR 0026), reused for a minute unless `refresh`. */
  async listRepos(refresh = false): Promise<GitHubRepo[]> {
    if (!refresh && this.repos && Date.now() - this.repos.at < REPOS_TTL_MS) return this.repos.list;
    const list = await this.client.listRepos();
    this.repos = { at: Date.now(), list };
    return list;
  }

  /** Creates a repository on the token's account after the Policy Engine allowed `repo.create` (ADR 0072). */
  async createRepo(req: { name: string; description?: string; private: boolean }, actor: Actor): Promise<GitHubRepo> {
    const decision = this.policy.decide(actor, "repo.create", req.name, { autonomyLevel: this.config.autonomy_level });
    if (decision.effect !== "allow") throw new GitHubIntegrationError("policy_denied", `creating ${req.name} denied: ${decision.reason}`);
    const known = await this.listRepos().catch(() => [] as GitHubRepo[]);
    const created = await this.client.createRepo(req);
    // GitHub's listing may lag a moment behind a new repository, and the clone needs it listed.
    this.repos = { at: Date.now(), list: [created, ...known.filter((r) => r.repo.toLowerCase() !== created.repo.toLowerCase())] };
    return created;
  }

  /** Clones `repo` into `dest` after the Policy Engine allowed `repo.clone` for the actor (ADR 0026). */
  async clone(repo: string, dest: string, actor: Actor): Promise<void> {
    const decision = this.policy.decide(actor, "repo.clone", repo, { autonomyLevel: this.config.autonomy_level });
    if (decision.effect !== "allow") throw new GitHubIntegrationError("policy_denied", `clone of ${repo} denied: ${decision.reason}`);
    const token = await this.vault.get("github/token");
    await cloneRepo({ repo, dest, token, gitUrl: this.config.github.git_url });
  }

  /** Pushes a run branch after the Policy Engine allowed `git.push` for it; returns the pushed commit. */
  async push(repoPath: string, repo: string, branch: string, autonomyLevel: number): Promise<string> {
    const decision = this.policy.decide(integration, "git.push", `${repo}:${branch}`, { autonomyLevel, branch });
    if (decision.effect !== "allow") throw new GitHubIntegrationError("policy_denied", `push of ${branch} denied: ${decision.reason}`);
    const token = await this.vault.get("github/token");
    return pushBranch({ repoPath, repo, branch, token, gitUrl: this.config.github.git_url });
  }

  /**
   * Refuses a run that would end in a PR when the token cannot push to `repo`, before any agent
   * works on it (go/no-go finding F5). A dry run writes nothing, so it needs no policy decision.
   */
  async checkPush(repoPath: string, repo: string): Promise<void> {
    const token = await this.vault.get("github/token");
    try {
      await checkPush({ repoPath, repo, token, gitUrl: this.config.github.git_url });
    } catch (err) {
      throw new GitHubIntegrationError(
        "push_denied",
        `${(err as Error).message}\nGive the GitHub token write access to ${repo} (fine-grained PAT: Contents and Pull requests read and write), then start the run again.`,
      );
    }
  }

  /**
   * Opens a draft PR into `base` (the default branch unless given; a ci-fix PR targets the pull
   * request's branch), or returns the one already open for the branch (a retried task must not fail on it).
   */
  async openDraftPr(pr: { repo: string; head: string; title: string; body: string; base?: string }): Promise<{ number: number; url: string }> {
    const existing = await this.client.findPullRequest(pr.repo, pr.head);
    if (existing) return existing;
    const base = pr.base ?? (await this.client.defaultBranch(pr.repo));
    return this.client.createPullRequest({ ...pr, base, draft: true });
  }
}

/** What GitHub says about a pull request right before auto-merge decides (ADR 0060). */
export type MergeFacts = {
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  head_sha: string;
  head_ref: string;
  head_repo: string;
  base_ref: string;
  node_id: string;
  title: string;
  default_branch: string;
  base_protected: boolean;
  files: string[];
  files_truncated: boolean;
  checks: { total: number; pending: number; notGreen: string[] };
};
