import { parseIssueRef, type Actor, type WorkItem } from "@vectr/contracts";
import { GitHubClient, pushBranch, repoFromRemote } from "@vectr/github";
import { remoteUrl } from "@vectr/runner";
import type { Config } from "../config.ts";
import type { PolicyEngine } from "../policy/engine.ts";
import type { Vault } from "../vault/vault.ts";

export class GitHubIntegrationError extends Error {
  readonly code: "invalid_issue" | "repo_mismatch" | "policy_denied";

  constructor(code: GitHubIntegrationError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const integration: Actor = { kind: "system", component: "github" };

/**
 * GitHub Integration (spec §6.7): the only module that talks to GitHub. Its token comes from the
 * Vault on each use (ADR 0007), and every write is decided by the Policy Engine first.
 */
export class GitHubIntegration {
  readonly client: GitHubClient;
  private readonly config: Config;
  private readonly vault: Vault;
  private readonly policy: PolicyEngine;

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

  /** Pushes a run branch after the Policy Engine allowed `git.push` for it; returns the pushed commit. */
  async push(repoPath: string, repo: string, branch: string, autonomyLevel: number): Promise<string> {
    const decision = this.policy.decide(integration, "git.push", `${repo}:${branch}`, { autonomyLevel, branch });
    if (decision.effect !== "allow") throw new GitHubIntegrationError("policy_denied", `push of ${branch} denied: ${decision.reason}`);
    const token = await this.vault.get("github/token");
    return pushBranch({ repoPath, repo, branch, token, gitUrl: this.config.github.git_url });
  }

  /** Opens a draft PR, or returns the one already open for the branch (a retried task must not fail on it). */
  async openDraftPr(pr: { repo: string; head: string; title: string; body: string }): Promise<{ number: number; url: string }> {
    const existing = await this.client.findPullRequest(pr.repo, pr.head);
    if (existing) return existing;
    const base = await this.client.defaultBranch(pr.repo);
    return this.client.createPullRequest({ ...pr, base, draft: true });
  }
}
