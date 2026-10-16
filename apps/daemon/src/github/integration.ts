import { parseIssueRef, type Actor, type WorkItem } from "@navarch/contracts";
import { checkPush, cloneRepo, fetchPullRequest, GitHubClient, pushBranch, repoFromRemote, type GitHubRepo } from "@navarch/github";
import { remoteUrl } from "@navarch/runner";
import type { Config } from "../config.ts";
import type { PolicyEngine } from "../policy/engine.ts";
import type { Vault } from "../vault/vault.ts";

export class GitHubIntegrationError extends Error {
  readonly code: "invalid_issue" | "repo_mismatch" | "policy_denied" | "push_denied" | "pr_closed";

  constructor(code: GitHubIntegrationError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const integration: Actor = { kind: "system", component: "github" };
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
    const { state, head_ref, head_sha, head_repo, base_ref, base_sha, draft, ...item } = await this.client.getPullRequest(origin, number);
    if (state !== "open") throw new GitHubIntegrationError("pr_closed", `${origin}#${number} is closed; Navarch works on open pull requests`);
    const token = await this.vault.get("github/token");
    const fetched = await fetchPullRequest({ repoPath, repo: origin, number, baseRef: base_ref, token, gitUrl: this.config.github.git_url });
    // What was fetched is what the run works on, even if the pull request moved since it was read.
    const failing_checks = await this.client.failingChecks(origin, fetched.head);
    return { ...item, pull_request: { head_ref, head_sha: fetched.head, head_repo, base_ref, base_sha: fetched.base, draft, failing_checks } };
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
