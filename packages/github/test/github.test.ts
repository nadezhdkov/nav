import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRepo } from "../../runner/test/helpers.ts";
import { cloneRepo, fetchPullRequest, GitHubClient, GitHubError, pushBranch, repoFromRemote } from "../src/index.ts";
import { fakeGitHub, type FakeGitHub } from "./fake-github.ts";

const servers: FakeGitHub[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function setup() {
  const gh = await fakeGitHub();
  servers.push(gh);
  gh.repos.set("acme/widgets", {
    default_branch: "main",
    issues: new Map([
      [7, { title: "Crash on empty input", body: "Steps:\n1. run with ''", labels: ["bug"], author: "alice" }],
      [8, { title: "No body", body: null, labels: [], author: "bob" }],
      [9, { title: "A PR", body: "", labels: [], author: "carol", pull_request: true }],
    ]),
  });
  const issued = gh.token;
  const client = new GitHubClient({ apiUrl: gh.apiUrl, token: async () => issued });
  return { gh, client };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
  }).trim();

/** A local "GitHub" for git: `<root>/acme/widgets.git`, a bare clone of the repository. */
function bareRemote(repo: string): { gitUrl: string; bare: string } {
  const root = mkdtempSync(join(tmpdir(), "navarch-remote-"));
  mkdirSync(join(root, "acme"));
  const bare = join(root, "acme", "widgets.git");
  execFileSync("git", ["clone", "-q", "--bare", repo, bare]);
  return { gitUrl: root, bare };
}

describe("GitHubClient", () => {
  it("reads an issue as a work item, with the token as a bearer", async () => {
    const { gh, client } = await setup();
    expect(await client.getIssue("acme/widgets", 7)).toEqual({
      source: "github",
      repo: "acme/widgets",
      number: 7,
      url: "https://github.com/acme/widgets/issues/7",
      title: "Crash on empty input",
      body: "Steps:\n1. run with ''",
      labels: ["bug"],
      author: "alice",
    });
    expect((await client.getIssue("acme/widgets", 8)).body).toBe("");
    expect(gh.requests.every((r) => r.authorization === `Bearer ${gh.token}`)).toBe(true);
  });

  it("refuses pull requests, unknown issues and a rejected token with clear errors", async () => {
    const { gh, client } = await setup();
    await expect(client.getIssue("acme/widgets", 9)).rejects.toThrow("is a pull request");
    await expect(client.getIssue("acme/widgets", 99)).rejects.toThrow("acme/widgets#99 not found");
    gh.token = "rotated";
    const err = await client.getIssue("acme/widgets", 7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(401);
    expect((err as Error).message).toContain("token");
  });

  it("opens a draft pull request against the default branch", async () => {
    const { gh, client } = await setup();
    expect(await client.defaultBranch("acme/widgets")).toBe("main");
    const pr = await client.createPullRequest({
      repo: "acme/widgets",
      head: "navarch/run_1/implement",
      base: "main",
      title: "fix: crash on empty input",
      body: "Fixes #7",
      draft: true,
    });
    expect(pr).toEqual({ number: 100, url: "https://github.com/acme/widgets/pull/100" });
    expect(gh.pulls[0]).toMatchObject({ head: "navarch/run_1/implement", base: "main", draft: true });
    await expect(
      client.createPullRequest({ repo: "acme/widgets", head: "navarch/run_1/implement", base: "main", title: "t", body: "", draft: true }),
    ).rejects.toThrow("already exists");
    expect(await client.findPullRequest("acme/widgets", "navarch/run_1/implement")).toEqual(pr);
    expect(await client.findPullRequest("acme/widgets", "navarch/other")).toBeUndefined();
  });
});

describe("repoFromRemote", () => {
  it("reads owner/name from GitHub remote URLs", () => {
    expect(repoFromRemote("https://github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(repoFromRemote("https://github.com/acme/widgets")).toBe("acme/widgets");
    expect(repoFromRemote("git@github.com:acme/widgets.git")).toBe("acme/widgets");
    expect(repoFromRemote("ssh://git@github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(repoFromRemote("https://gitlab.com/acme/widgets.git")).toBeUndefined();
    expect(repoFromRemote("/tmp/somewhere")).toBeUndefined();
    expect(repoFromRemote("https://github.com/../widgets.git")).toBeUndefined();
  });
});

describe("pushBranch", () => {
  it("pushes a navarch/* branch to the repository's remote and keeps the token out of git config", async () => {
    const repo = makeRepo();
    const { gitUrl, bare } = bareRemote(repo);
    git(repo, "switch", "-q", "-c", "navarch/run_1/implement");
    writeFileSync(join(repo, "fix.txt"), "fixed\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "fix");
    const head = git(repo, "rev-parse", "HEAD");
    // The token travels in git's environment: repository hooks must not run and see it.
    const hookRan = join(repo, "hook-ran");
    writeFileSync(join(repo, ".git", "hooks", "pre-push"), `#!/bin/sh\nenv > '${hookRan}'\n`, { mode: 0o755 });

    const commit = await pushBranch({ repoPath: repo, repo: "acme/widgets", branch: "navarch/run_1/implement", token: "github_pat_secret", gitUrl });
    expect(commit).toBe(head);
    expect(git(bare, "rev-parse", "refs/heads/navarch/run_1/implement")).toBe(head);
    expect(readFileSync(join(repo, ".git", "config"), "utf8")).not.toContain("github_pat_secret");
    expect(existsSync(hookRan)).toBe(false);
  });

  it("never pushes outside navarch/* and never forces", async () => {
    const repo = makeRepo();
    const { gitUrl, bare } = bareRemote(repo);
    const push = (branch: string) => pushBranch({ repoPath: repo, repo: "acme/widgets", branch, token: "t", gitUrl });
    for (const branch of ["main", "feature/x", "navarch/../main", "navarch/", "navarch/a b", "navarch/x:refs/heads/main"]) {
      await expect(push(branch), branch).rejects.toThrow("only navarch/* branches");
    }

    // The remote branch moved on: a non-forced push must fail instead of overwriting it.
    git(repo, "switch", "-q", "-c", "navarch/run_2/implement");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "a");
    await push("navarch/run_2/implement");
    git(repo, "reset", "-q", "--hard", "HEAD~1");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "b");
    const before = git(bare, "rev-parse", "refs/heads/navarch/run_2/implement");
    await expect(push("navarch/run_2/implement")).rejects.toThrow("push failed");
    expect(git(bare, "rev-parse", "refs/heads/navarch/run_2/implement")).toBe(before);
  });
});

describe("GitHubClient.listIssues", () => {
  it("lists open issues without pull requests, newest update first", async () => {
    const { gh, client } = await setup();
    gh.repos.get("acme/widgets")!.issues.set(10, { title: "Newer", body: "", labels: [], author: "dan", updated_at: "2026-03-01T00:00:00Z" });
    gh.repos.get("acme/widgets")!.issues.set(11, { title: "Closed", body: "", labels: [], author: "eve", state: "closed" });
    const res = await client.listIssues("acme/widgets");
    if (res.notModified) throw new Error("expected a listing");
    expect(res.issues.map((i) => i.number)).toEqual([10, 8, 7]);
    expect(res.issues[1]).toMatchObject({ body: "", state: "open", author: "bob" });
    expect(res.etag).toMatch(/^"/);
  });

  it("answers notModified to a matching ETag, and lists closed issues with since", async () => {
    const { gh, client } = await setup();
    const first = await client.listIssues("acme/widgets");
    if (first.notModified) throw new Error("expected a listing");
    expect(await client.listIssues("acme/widgets", { etag: first.etag! })).toEqual({ notModified: true });
    expect(gh.requests.at(-1)?.status).toBe(304);
    gh.repos.get("acme/widgets")!.issues.get(7)!.state = "closed";
    gh.repos.get("acme/widgets")!.issues.get(7)!.updated_at = "2026-05-01T00:00:00Z";
    const since = await client.listIssues("acme/widgets", { since: "2026-04-01T00:00:00Z" });
    if (since.notModified) throw new Error("expected a listing");
    expect(since.issues).toEqual([expect.objectContaining({ number: 7, state: "closed" })]);
    expect(gh.requests.at(-1)?.query).toContain("state=all");
  });

  it("follows pages of 100", async () => {
    const { gh, client } = await setup();
    const issues = gh.repos.get("acme/widgets")!.issues;
    for (let n = 100; n < 330; n++) issues.set(n, { title: `#${n}`, body: "", labels: [], author: "x" });
    const res = await client.listIssues("acme/widgets");
    if (res.notModified) throw new Error("expected a listing");
    expect(res.issues).toHaveLength(232);
    expect(gh.requests.filter((r) => r.path.endsWith("/issues"))).toHaveLength(3);
  });

  it("reports when a rate limit resets", async () => {
    const { gh, client } = await setup();
    gh.rateLimitedUntil = 1_900_000_000;
    const err = await client.listIssues("acme/widgets").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).resetAt).toBe(new Date(1_900_000_000_000).toISOString());
  });
});

describe("GitHubClient.listRepos (ADR 0026)", () => {
  it("lists every repository the token reaches, own, collaborator and organization, across pages", async () => {
    const { gh, client } = await setup();
    gh.userRepos = [
      { full_name: "nadezhdkov/secret", private: true, description: "mine", push: true },
      { full_name: "acme/widgets", private: false, push: false },
      ...Array.from({ length: 120 }, (_, i) => ({ full_name: `org/repo-${i}`, private: true })),
    ];
    const repos = await client.listRepos();
    expect(repos).toHaveLength(122);
    expect(repos[0]).toEqual({
      repo: "nadezhdkov/secret",
      owner: "nadezhdkov",
      private: true,
      description: "mine",
      default_branch: "main",
      pushed_at: "2026-01-01T00:00:00Z",
      can_push: true,
    });
    expect(repos[1]).toMatchObject({ repo: "acme/widgets", private: false, can_push: false });
    const calls = gh.requests.filter((r) => r.path === "/user/repos");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.query).toContain("affiliation=owner%2Ccollaborator%2Corganization_member");
  });
});

describe("cloneRepo (ADR 0026)", () => {
  it("clones over the GitHub URL with the token for that one command, and leaves a plain GitHub origin", async () => {
    const repo = makeRepo();
    const { gitUrl } = bareRemote(repo);
    const dest = join(mkdtempSync(join(tmpdir(), "navarch-clones-")), "acme", "widgets");
    await cloneRepo({ repo: "acme/widgets", dest, token: "github_pat_secret", gitUrl });
    expect(git(dest, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(git(dest, "remote", "get-url", "origin")).toBe("https://github.com/acme/widgets.git");
    expect(readFileSync(join(dest, ".git", "config"), "utf8")).not.toContain("github_pat_secret");
  });

  it("refuses a bad repository name and a destination that already exists", async () => {
    const dest = mkdtempSync(join(tmpdir(), "navarch-clones-"));
    await expect(cloneRepo({ repo: "../etc", dest: join(dest, "x"), token: "t" })).rejects.toThrow(/invalid repository name/);
    await expect(cloneRepo({ repo: "acme/widgets", dest, token: "t" })).rejects.toThrow(/already exists/);
  });
});

describe("pull requests (ADR 0032)", () => {
  it("reads a pull request with its head and base, and the failing checks with their log tails", async () => {
    const { gh, client } = await setup();
    gh.pullRequests.set("acme/widgets#12", { title: "Add cache", body: "Speeds up", author: "dana", labels: ["perf"], head_ref: "cache", head_sha: "abc123", head_repo: "dana/widgets", base_ref: "main", base_sha: "def456", draft: true });
    gh.checks.set("abc123", [
      { id: 1, name: "test", conclusion: "failure", actions: true, log: `${"x".repeat(7000)}\nError: expected 2, got 3 token=github_pat_leakleakleakleak1234` },
      { id: 2, name: "lint", conclusion: "success", actions: true, log: "ok" },
      { id: 3, name: "external", conclusion: "timed_out", output: { title: "Timed out", summary: "after 60 min" } },
      { id: 4, name: "expired", conclusion: "failure", actions: true, output: { summary: "logs expired" } },
    ]);
    const pr = await client.getPullRequest("acme/widgets", 12);
    expect(pr).toMatchObject({ kind: "pull_request", number: 12, title: "Add cache", author: "dana", labels: ["perf"], state: "open", draft: true, head_ref: "cache", head_sha: "abc123", head_repo: "dana/widgets", base_ref: "main", base_sha: "def456" });
    const checks = await client.failingChecks("acme/widgets", "abc123");
    expect(checks.map((c) => [c.name, c.conclusion])).toEqual([["test", "failure"], ["external", "timed_out"], ["expired", "failure"]]);
    expect(checks[0]!.log_tail.length).toBeLessThanOrEqual(6_000);
    expect(checks[0]!.log_tail).toContain("expected 2, got 3");
    expect(checks[0]!.log_tail).not.toContain("github_pat_leak");
    expect(checks[1]!.log_tail).toBe("Timed out\n\nafter 60 min");
    expect(checks[2]!.log_tail).toBe("logs expired");
  });

  it("posts COMMENT reviews on the right side and comments, and lists them back", async () => {
    const { gh, client } = await setup();
    gh.pullRequests.set("acme/widgets#12", { title: "t", body: null, author: "dana", head_ref: "h", head_sha: "abc", base_ref: "main", base_sha: "def" });
    await client.createReview({ repo: "acme/widgets", number: 12, commit_id: "abc", body: "Review", comments: [{ path: "a.ts", line: 2, body: "nit" }] });
    expect(gh.reviews).toEqual([expect.objectContaining({ event: "COMMENT", commit_id: "abc", comments: [{ path: "a.ts", line: 2, side: "RIGHT", body: "nit" }] })]);
    expect(await client.listReviews("acme/widgets", 12)).toEqual([expect.objectContaining({ body: "Review" })]);
    await client.createComment("acme/widgets", 12, "Flaky");
    expect(await client.listComments("acme/widgets", 12)).toEqual([expect.objectContaining({ body: "Flaky" })]);
  });
});

describe("watching checks (ADR 0041)", () => {
  it("lists open pull requests with their head and reads a head's check status without logs", async () => {
    const { gh, client } = await setup();
    gh.pullRequests.set("acme/widgets#12", { title: "Add cache", body: null, author: "dana", head_ref: "cache", head_sha: "abc123", base_ref: "main", base_sha: "def456" });
    gh.pullRequests.set("acme/widgets#13", { title: "From a fork", body: null, author: "eve", head_ref: "x", head_sha: "bbb222", head_repo: "eve/widgets", base_ref: "main", base_sha: "def456", draft: true });
    gh.pullRequests.set("acme/widgets#14", { title: "Old", body: null, author: "dana", head_ref: "old", head_sha: "ccc333", base_ref: "main", base_sha: "def456", state: "closed" });
    gh.pullRequests.set("other/repo#1", { title: "Elsewhere", body: null, author: "dana", head_ref: "z", head_sha: "ddd444", base_ref: "main", base_sha: "def456" });
    expect(await client.listOpenPullRequests("acme/widgets")).toEqual([
      expect.objectContaining({ number: 12, title: "Add cache", author: "dana", head_ref: "cache", head_sha: "abc123", head_repo: "acme/widgets", draft: false }),
      expect.objectContaining({ number: 13, head_repo: "eve/widgets", draft: true }),
    ]);

    gh.checks.set("abc123", [
      { id: 1, name: "test", conclusion: "failure", actions: true, log: "boom" },
      { id: 2, name: "lint", conclusion: "success" },
      { id: 3, name: "e2e", conclusion: null, status: "in_progress" },
      { id: 4, name: "slow", conclusion: "timed_out" },
    ]);
    const status = await client.checkStatus("acme/widgets", "abc123");
    expect(status.pending).toBe(1);
    expect(status.failing.map((c) => [c.name, c.conclusion])).toEqual([["test", "failure"], ["slow", "timed_out"]]);
    expect(status.failing[0]).not.toHaveProperty("log_tail");
    expect(gh.requests.some((r) => r.path.includes("/actions/jobs/"))).toBe(false);
    expect(await client.checkStatus("acme/widgets", "fff000")).toEqual({ pending: 0, failing: [] });
  });
});

describe("fetchPullRequest (ADR 0032)", () => {
  it("fetches the head and base into refs/navarch/pr without touching branches or running hooks", async () => {
    const repo = makeRepo();
    const { gitUrl, bare } = bareRemote(repo);
    const base = git(repo, "rev-parse", "HEAD");
    // The pull request's head lives only on "GitHub", under refs/pull/<N>/head.
    const author = mkdtempSync(join(tmpdir(), "navarch-pr-"));
    execFileSync("git", ["clone", "-q", bare, author]);
    writeFileSync(join(author, "pr.txt"), "change\n");
    git(author, "add", ".");
    git(author, "commit", "-q", "-m", "pr");
    git(author, "push", "-q", "origin", "HEAD:refs/pull/12/head");
    const head = git(author, "rev-parse", "HEAD");
    const branches = git(repo, "branch", "--list");
    const hookRan = join(repo, "hook-ran");
    writeFileSync(join(repo, ".git", "hooks", "reference-transaction"), `#!/bin/sh\ntouch '${hookRan}'\n`, { mode: 0o755 });

    const fetched = await fetchPullRequest({ repoPath: repo, repo: "acme/widgets", number: 12, baseRef: "main", token: "github_pat_secret", gitUrl });
    expect(fetched).toEqual({ head, base });
    expect(git(repo, "rev-parse", "refs/navarch/pr/12/head")).toBe(head);
    expect(git(repo, "branch", "--list")).toBe(branches);
    expect(existsSync(hookRan)).toBe(false);
    await expect(fetchPullRequest({ repoPath: repo, repo: "acme/widgets", number: 12, baseRef: "a..b", token: "t", gitUrl })).rejects.toThrow(/invalid base branch/);
  });
});
