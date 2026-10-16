import { parseIssueRef, type Actor, type WorkItem } from "@navarch/contracts";
import { checkPush, cloneRepo, GitHubClient, pushBranch, repoFromRemote, type GitHubRepo } from "@navarch/github";
import { remoteUrl } from "@navarch/runner";
import type { Config } from "../config.ts";
import type { PolicyEngine } from "../policy/engine.ts";
import type { Vault } from "../vault/vault.ts";

export class GitHubIntegrationError extends Error {
  readonly code: "invalid_issue" | "repo_mismatch" | "policy_denied" | "push_denied";

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
    const parsed = parseIssueRef(ref);
    if (!parsed) throw new GitHubIntegrationError("invalid_issue", `expected owner/repo#number, got ${JSON.stringify(ref)}`);
    const origin = await this.repoOf(repoPath);
    if (!origin || origin.toLowerCase() !== parsed.repo.toLowerCase()) {
      throw new GitHubIntegrationError(
        "repo_mismatch",
        `${repoPath} has origin ${origin ?? "(none on GitHub)"}, so it cannot work on ${parsed.repo}#${parsed.number}`,
      );
    }
    return this.client.getIssue(origin, parsed.number);
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

  /** Opens a draft PR, or returns the one already open for the branch (a retried task must not fail on it). */
  async openDraftPr(pr: { repo: string; head: string; title: string; body: string }): Promise<{ number: number; url: string }> {
    const existing = await this.client.findPullRequest(pr.repo, pr.head);
    if (existing) return existing;
    const base = await this.client.defaultBranch(pr.repo);
    return this.client.createPullRequest({ ...pr, base, draft: true });
  }
}
