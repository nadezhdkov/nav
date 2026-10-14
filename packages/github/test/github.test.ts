import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRepo } from "../../runner/test/helpers.ts";
import { GitHubClient, GitHubError, pushBranch, repoFromRemote } from "../src/index.ts";
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
  const root = mkdtempSync(join(tmpdir(), "vectr-remote-"));
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
      head: "vectr/run_1/implement",
      base: "main",
      title: "fix: crash on empty input",
      body: "Fixes #7",
      draft: true,
    });
    expect(pr).toEqual({ number: 100, url: "https://github.com/acme/widgets/pull/100" });
    expect(gh.pulls[0]).toMatchObject({ head: "vectr/run_1/implement", base: "main", draft: true });
    await expect(
      client.createPullRequest({ repo: "acme/widgets", head: "vectr/run_1/implement", base: "main", title: "t", body: "", draft: true }),
    ).rejects.toThrow("already exists");
    expect(await client.findPullRequest("acme/widgets", "vectr/run_1/implement")).toEqual(pr);
    expect(await client.findPullRequest("acme/widgets", "vectr/other")).toBeUndefined();
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
  });
});

describe("pushBranch", () => {
  it("pushes a vectr/* branch to the repository's remote and keeps the token out of git config", async () => {
    const repo = makeRepo();
    const { gitUrl, bare } = bareRemote(repo);
    git(repo, "switch", "-q", "-c", "vectr/run_1/implement");
    writeFileSync(join(repo, "fix.txt"), "fixed\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "fix");
    const head = git(repo, "rev-parse", "HEAD");

    const commit = await pushBranch({ repoPath: repo, repo: "acme/widgets", branch: "vectr/run_1/implement", token: "github_pat_secret", gitUrl });
    expect(commit).toBe(head);
    expect(git(bare, "rev-parse", "refs/heads/vectr/run_1/implement")).toBe(head);
    expect(readFileSync(join(repo, ".git", "config"), "utf8")).not.toContain("github_pat_secret");
  });

  it("never pushes outside vectr/* and never forces", async () => {
    const repo = makeRepo();
    const { gitUrl, bare } = bareRemote(repo);
    const push = (branch: string) => pushBranch({ repoPath: repo, repo: "acme/widgets", branch, token: "t", gitUrl });
    for (const branch of ["main", "feature/x", "vectr/../main", "vectr/", "vectr/a b", "vectr/x:refs/heads/main"]) {
      await expect(push(branch), branch).rejects.toThrow("only vectr/* branches");
    }

    // The remote branch moved on: a non-forced push must fail instead of overwriting it.
    git(repo, "switch", "-q", "-c", "vectr/run_2/implement");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "a");
    await push("vectr/run_2/implement");
    git(repo, "reset", "-q", "--hard", "HEAD~1");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "b");
    const before = git(bare, "rev-parse", "refs/heads/vectr/run_2/implement");
    await expect(push("vectr/run_2/implement")).rejects.toThrow("push failed");
    expect(git(bare, "rev-parse", "refs/heads/vectr/run_2/implement")).toBe(before);
  });
});
