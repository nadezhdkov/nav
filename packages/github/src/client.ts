import type { WorkItem } from "@navarch/contracts";

/** Returns the GitHub token when a request needs it (ADR 0007: the Vault, or a GitHub App later). */
export type TokenProvider = () => Promise<string>;

export type GitHubClientOptions = {
  /** `https://api.github.com` unless a test or GitHub Enterprise says otherwise. */
  apiUrl?: string;
  token: TokenProvider;
};

export class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * GitHub REST client (spec §6.7). Only the GitHub Integration uses it, and writes reach it only
 * after the Policy Engine allowed them.
 */
export class GitHubClient {
  private readonly apiUrl: string;
  private readonly token: TokenProvider;

  constructor(options: GitHubClientOptions) {
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.token = options.token;
  }

  async getIssue(repo: string, number: number): Promise<WorkItem> {
    const issue = await this.request<{
      html_url: string;
      title: string;
      body: string | null;
      labels: (string | { name?: string })[];
      user: { login: string } | null;
      pull_request?: unknown;
    }>("GET", `/repos/${repo}/issues/${number}`, undefined, `${repo}#${number}`);
    if (issue.pull_request) throw new GitHubError(422, `${repo}#${number} is a pull request, not an issue`);
    return {
      source: "github",
      repo,
      number,
      url: issue.html_url,
      title: issue.title,
      body: issue.body ?? "",
      labels: issue.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
      author: issue.user?.login ?? "ghost",
    };
  }

  async defaultBranch(repo: string): Promise<string> {
    return (await this.request<{ default_branch: string }>("GET", `/repos/${repo}`, undefined, repo)).default_branch;
  }

  async createPullRequest(pr: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<{ number: number; url: string }> {
    const { repo, ...body } = pr;
    const created = await this.request<{ number: number; html_url: string }>("POST", `/repos/${repo}/pulls`, body, repo);
    return { number: created.number, url: created.html_url };
  }

  /** The PR whose head is `branch` in the same repository, open or closed (makes opening a PR idempotent). */
  async findPullRequest(repo: string, branch: string): Promise<{ number: number; url: string } | undefined> {
    const owner = repo.split("/")[0]!;
    const query = new URLSearchParams({ head: `${owner}:${branch}`, state: "all" });
    const pulls = await this.request<{ number: number; html_url: string }[]>("GET", `/repos/${repo}/pulls?${query}`, undefined, repo);
    const pr = pulls[0];
    return pr ? { number: pr.number, url: pr.html_url } : undefined;
  }

  private async request<T>(method: string, path: string, body: unknown, what: string): Promise<T> {
    const res = await fetch(this.apiUrl + path, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${await this.token()}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "navarch",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (res.ok) return json as T;
    throw new GitHubError(res.status, describe(res.status, what, json));
  }
}

function describe(status: number, what: string, json: Record<string, unknown>): string {
  const details = Array.isArray(json.errors)
    ? (json.errors as { message?: string }[]).map((e) => e.message).filter(Boolean).join("; ")
    : "";
  const message = [String(json.message ?? ""), details].filter(Boolean).join(": ");
  if (status === 401) return `GitHub rejected the token (expired or revoked?): ${message}`;
  if (status === 403) return `GitHub refused ${what}: the token lacks a permission or hit a rate limit: ${message}`;
  if (status === 404) return `${what} not found, or the token cannot see it`;
  return `GitHub returned ${status} for ${what}: ${message}`;
}
