import { redact, type FailingCheck, type GitHubRepoView, type PullRequestInfo, type WorkItem } from "@navarch/contracts";

/** Returns the GitHub token when a request needs it (ADR 0007: the Vault, or a GitHub App later). */
export type TokenProvider = () => Promise<string>;

export type GitHubClientOptions = {
  /** `https://api.github.com` unless a test or GitHub Enterprise says otherwise. */
  apiUrl?: string;
  token: TokenProvider;
};

export class GitHubError extends Error {
  readonly status: number;
  /** On a rate limit: when it resets (ISO 8601), if GitHub said so. */
  readonly resetAt?: string;

  constructor(status: number, message: string, resetAt?: string) {
    super(message);
    this.status = status;
    if (resetAt) this.resetAt = resetAt;
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

  /**
   * Issues of a repository, pull requests left out, newest update first (spec §6.7.3 polling).
   * Without `since`, the open ones; with it, every issue updated since then, open or closed. The
   * first page is a conditional request on `etag`: `notModified` costs no rate limit.
   */
  async listIssues(
    repo: string,
    options: { since?: string; etag?: string; maxPages?: number } = {},
  ): Promise<{ notModified: true } | { notModified: false; etag?: string; issues: IssueListing[] }> {
    const query = new URLSearchParams({ state: options.since ? "all" : "open", sort: "updated", direction: "desc", per_page: "100" });
    if (options.since) query.set("since", options.since);
    const issues: IssueListing[] = [];
    let etag: string | undefined;
    for (let page = 1; page <= (options.maxPages ?? 5); page++) {
      query.set("page", String(page));
      const res = await this.send("GET", `/repos/${repo}/issues?${query}`, undefined, page === 1 && options.etag ? { "if-none-match": options.etag } : {});
      if (res.status === 304) return { notModified: true };
      const json = await readJson(res);
      if (!res.ok) throw failure(res, repo, json);
      if (page === 1) etag = res.headers.get("etag") ?? undefined;
      const rows = json as RawIssue[];
      for (const raw of rows) {
        if (raw.pull_request) continue;
        issues.push({
          source: "github",
          repo,
          number: raw.number,
          url: raw.html_url,
          title: raw.title,
          body: raw.body ?? "",
          labels: raw.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
          author: raw.user?.login ?? "ghost",
          state: raw.state === "closed" ? "closed" : "open",
          updated_at: raw.updated_at,
        });
      }
      if (rows.length < 100) break;
    }
    return { notModified: false, ...(etag ? { etag } : {}), issues };
  }

  /**
   * Every repository the token reaches (ADR 0026): the user's own, those they collaborate on and
   * those of their organizations, most recently pushed first. A fine-grained token lists only the
   * repositories it was granted.
   */
  async listRepos(options: { maxPages?: number } = {}): Promise<GitHubRepo[]> {
    const query = new URLSearchParams({ affiliation: "owner,collaborator,organization_member", sort: "pushed", per_page: "100" });
    const repos: GitHubRepo[] = [];
    for (let page = 1; page <= (options.maxPages ?? 10); page++) {
      query.set("page", String(page));
      const rows = await this.request<RawRepo[]>("GET", `/user/repos?${query}`, undefined, "repositories");
      for (const r of rows) {
        repos.push({
          repo: r.full_name,
          owner: r.owner?.login ?? r.full_name.split("/")[0]!,
          private: r.private,
          description: r.description ?? null,
          default_branch: r.default_branch,
          pushed_at: r.pushed_at ?? null,
          can_push: r.permissions?.push ?? false,
        });
      }
      if (rows.length < 100) break;
    }
    return repos;
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

  /** A pull request with its head and base (ADR 0032). Title and body are untrusted data. */
  async getPullRequest(repo: string, number: number): Promise<PullRequestDetails> {
    const pr = await this.request<{
      html_url: string;
      title: string;
      body: string | null;
      labels: { name?: string }[];
      user: { login: string } | null;
      state: string;
      draft?: boolean;
      head: { ref: string; sha: string; repo: { full_name: string } | null };
      base: { ref: string; sha: string };
    }>("GET", `/repos/${repo}/pulls/${number}`, undefined, `${repo}#${number}`);
    return {
      source: "github",
      kind: "pull_request",
      repo,
      number,
      url: pr.html_url,
      title: pr.title,
      body: pr.body ?? "",
      labels: pr.labels.map((l) => l.name ?? "").filter(Boolean),
      author: pr.user?.login ?? "ghost",
      state: pr.state === "open" ? "open" : "closed",
      draft: pr.draft ?? false,
      head_ref: pr.head.ref,
      head_sha: pr.head.sha,
      // A fork that was deleted has no repository left; it is not this one.
      head_repo: pr.head.repo?.full_name ?? "(deleted fork)",
      base_ref: pr.base.ref,
      base_sha: pr.base.sha,
    };
  }

  /**
   * The failing check runs of a commit (`failure` or `timed_out`), at most `max`, each with the tail
   * of its log: a GitHub Actions job's own log, else the check's output (ADR 0032). Untrusted text.
   */
  async failingChecks(repo: string, sha: string, options: { max?: number; tailChars?: number } = {}): Promise<FailingCheck[]> {
    const { max = 5, tailChars = 6_000 } = options;
    const listing = await this.request<{
      check_runs: { id: number; name: string; conclusion: string | null; html_url: string; app?: { slug?: string } | null; output?: { title?: string | null; summary?: string | null; text?: string | null } }[];
    }>("GET", `/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`, undefined, `checks of ${repo}@${sha.slice(0, 7)}`);
    const failing = listing.check_runs.filter((c) => c.conclusion === "failure" || c.conclusion === "timed_out").slice(0, max);
    const out: FailingCheck[] = [];
    for (const c of failing) {
      let log = "";
      if (c.app?.slug === "github-actions") {
        // The logs URL redirects to a signed download; fetch drops the token on that other host.
        const res = await this.send("GET", `/repos/${repo}/actions/jobs/${c.id}/logs`, undefined);
        if (res.ok) log = await res.text();
        else await res.body?.cancel();
      }
      if (!log) log = [c.output?.title, c.output?.summary, c.output?.text].filter(Boolean).join("\n\n");
      out.push({ name: c.name, conclusion: c.conclusion ?? "unknown", url: c.html_url, log_tail: redact(log.slice(-tailChars)) });
    }
    return out;
  }

  /** Reviews of a pull request, for finding one already posted (first page of 100). */
  async listReviews(repo: string, number: number): Promise<{ id: number; body: string; url: string }[]> {
    const rows = await this.request<{ id: number; body: string | null; html_url: string }[]>("GET", `/repos/${repo}/pulls/${number}/reviews?per_page=100`, undefined, `reviews of ${repo}#${number}`);
    return rows.map((r) => ({ id: r.id, body: r.body ?? "", url: r.html_url }));
  }

  /** Posts a review. Navarch only ever posts `COMMENT` reviews (ADR 0032). */
  async createReview(review: { repo: string; number: number; commit_id: string; body: string; comments: { path: string; line: number; body: string }[] }): Promise<{ id: number; url: string }> {
    const { repo, number, ...rest } = review;
    const body = { ...rest, event: "COMMENT", comments: rest.comments.map((c) => ({ ...c, side: "RIGHT" })) };
    const created = await this.request<{ id: number; html_url: string }>("POST", `/repos/${repo}/pulls/${number}/reviews`, body, `a review on ${repo}#${number}`);
    return { id: created.id, url: created.html_url };
  }

  /** Comments of an issue or pull request (first page of 100). */
  async listComments(repo: string, number: number): Promise<{ id: number; body: string; url: string }[]> {
    const rows = await this.request<{ id: number; body: string | null; html_url: string }[]>("GET", `/repos/${repo}/issues/${number}/comments?per_page=100`, undefined, `comments of ${repo}#${number}`);
    return rows.map((r) => ({ id: r.id, body: r.body ?? "", url: r.html_url }));
  }

  async createComment(repo: string, number: number, body: string): Promise<{ id: number; url: string }> {
    const created = await this.request<{ id: number; html_url: string }>("POST", `/repos/${repo}/issues/${number}/comments`, { body }, `a comment on ${repo}#${number}`);
    return { id: created.id, url: created.html_url };
  }

  /** Whether a pull request is still open, and how it ended (ADR 0037). */
  async pullRequestState(repo: string, number: number): Promise<{ state: "open" | "closed"; merged: boolean; closed_at: string | null; head_sha: string }> {
    const pr = await this.request<{ state: string; merged?: boolean; merged_at?: string | null; closed_at?: string | null; head: { sha: string } }>(
      "GET",
      `/repos/${repo}/pulls/${number}`,
      undefined,
      `${repo}#${number}`,
    );
    return {
      state: pr.state === "open" ? "open" : "closed",
      merged: Boolean(pr.merged ?? pr.merged_at),
      closed_at: pr.closed_at ?? null,
      head_sha: pr.head.sha,
    };
  }

  /** How many commits `head` has that `base` has not (`ahead_by` of the compare API). */
  async commitsAhead(repo: string, base: string, head: string): Promise<number> {
    const cmp = await this.request<{ ahead_by: number }>("GET", `/repos/${repo}/compare/${base}...${head}`, undefined, repo);
    return cmp.ahead_by;
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
    const res = await this.send(method, path, body);
    const json = await readJson(res);
    if (res.ok) return json as T;
    throw failure(res, what, json);
  }

  private async send(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(this.apiUrl + path, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${await this.token()}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "navarch",
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  }
}

/** A pull request as read from GitHub, before the run fetches it and lists its checks. */
export type PullRequestDetails = WorkItem & Omit<PullRequestInfo, "failing_checks"> & { state: "open" | "closed" };

/** A repository as GitHub lists it, before Navarch adds what it knows locally. */
export type GitHubRepo = Omit<GitHubRepoView, "project_id" | "path">;

type RawRepo = {
  full_name: string;
  owner?: { login: string };
  private: boolean;
  description: string | null;
  default_branch: string;
  pushed_at: string | null;
  permissions?: { push?: boolean };
};

/** An issue from a listing, with what a sync needs to tell new, changed and closed apart. */
export type IssueListing = WorkItem & { state: "open" | "closed"; updated_at: string };

type RawIssue = {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  labels: (string | { name?: string })[];
  user: { login: string } | null;
  state: string;
  updated_at: string;
  pull_request?: unknown;
};

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

function failure(res: Response, what: string, json: unknown): GitHubError {
  const body = (json && typeof json === "object" && !Array.isArray(json) ? json : {}) as Record<string, unknown>;
  const reset = res.status === 403 || res.status === 429 ? rateLimitReset(res.headers) : undefined;
  if (reset) return new GitHubError(res.status, `GitHub rate limit reached for ${what}; it resets at ${reset}`, reset);
  return new GitHubError(res.status, describe(res.status, what, body));
}

/** When a GitHub rate limit resets: `x-ratelimit-reset` (epoch seconds) or `retry-after` (seconds). */
export function rateLimitReset(headers: Headers, now = Date.now()): string | undefined {
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (headers.get("x-ratelimit-remaining") === "0" && reset > 0) return new Date(reset * 1000).toISOString();
  const after = Number(headers.get("retry-after"));
  return after > 0 ? new Date(now + after * 1000).toISOString() : undefined;
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
