import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalView, NavarchEvent, ProjectView, RunDetail } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { fakeGitHub, type FakeGitHub } from "../../../packages/github/test/fake-github.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { Vault } from "../src/vault/vault.ts";

const daemons: Daemon[] = [];
const servers: FakeGitHub[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
  for (const s of servers.splice(0)) await s.close();
});

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();

const AUTH = ["export function login(user: string) {", "  if (!user) throw new Error('missing user');", "  return createSession(user);", "}"].join("\n");
const AUTH_AFTER = ["export function login(user: string) {", "  if (!user) throw new Error('missing user');", "  checkRateLimit(user);", "  return createSession(user);", "}"].join("\n");

/**
 * acme/widgets with specs on main, a bare "GitHub" remote where pull request 7 was squash-merged
 * (a commit on main the local clone does not have yet), and pull request 8 still open.
 */
async function setup() {
  const repo = makeRepo();
  git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "auth.ts"), AUTH);
  mkdirSync(join(repo, ".navarch", "specs"), { recursive: true });
  writeFileSync(join(repo, ".navarch", "specs", "auth.md"), "# Authentication\n\n## Claims\n\n- 🟢 **rejects-empty** login throws when no user is given — `src/auth.ts:2`\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "add auth and its specs");
  const before = git(repo, "rev-parse", "HEAD");

  const gitUrl = mkdtempSync(join(tmpdir(), "navarch-remote-"));
  mkdirSync(join(gitUrl, "acme"));
  const bare = join(gitUrl, "acme", "widgets.git");
  execFileSync("git", ["clone", "-q", "--bare", repo, bare]);
  const author = mkdtempSync(join(tmpdir(), "navarch-author-"));
  execFileSync("git", ["clone", "-q", bare, author]);
  writeFileSync(join(author, "src", "auth.ts"), AUTH_AFTER);
  git(author, "commit", "-qam", "Add login rate limit (#7)");
  git(author, "push", "-q", "origin", "HEAD:main");
  const merge = git(author, "rev-parse", "HEAD");

  const gh = await fakeGitHub();
  servers.push(gh);
  gh.repos.set("acme/widgets", { default_branch: "main", issues: new Map() });
  gh.pullRequests.set("acme/widgets#7", { title: "Add login rate limit", body: "Refuse login after too many attempts.", author: "erin", head_ref: "rate-limit", head_sha: merge, base_ref: "main", base_sha: before, state: "closed", merged: true, merge_commit_sha: merge });
  gh.pullRequests.set("acme/widgets#8", { title: "Still open", body: "", author: "erin", head_ref: "wip", head_sha: before, base_ref: "main", base_sha: before });

  const home = tempHome();
  const claude = fakeClaude("specs");
  const daemon = new Daemon({
    home,
    config: Config.parse({ daemon: { port: 0 }, routing: { enabled: false }, github: { api_url: gh.apiUrl, git_url: gitUrl }, inbox: { poll_minutes: 0 } }),
    adapters: { "claude-code": claude.options },
    vault: new Vault({ env: { NAVARCH_SECRET_GITHUB_TOKEN: gh.token } }),
  });
  await daemon.start();
  daemons.push(daemon);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(daemon.url + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  const until = async <T>(read: () => Promise<T | undefined>): Promise<T> => {
    const end = Date.now() + 15_000;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((res) => setTimeout(res, 50));
    }
  };
  await api<ProjectView>("POST", "/api/v1/projects", { path: repo });
  return { repo, bare, gh, api, until, claude, merge };
}

describe("spec-sync Flow (ADR 0049)", () => {
  it("describes a merged pull request as a verified addendum and opens a draft PR with it", async () => {
    const { repo, bare, gh, api, until, claude, merge } = await setup();
    const created = await api<RunDetail>("POST", "/api/v1/runs", { repo_path: repo, flow: "spec-sync", pull_request: "acme/widgets#7" });
    expect(created.status).toBe(201);
    expect(created.body.work_item).toMatchObject({ kind: "pull_request", number: 7 });

    const approval = await until(async () => (await api<ApprovalView[]>("GET", "/api/v1/approvals?status=pending")).body[0]);
    expect(approval).toMatchObject({ action: "github.pr.create" });
    expect(approval.summary).toContain("spec addendum for #7");
    await api("POST", `/api/v1/approvals/${approval.id}`, { decision: "approve" });
    const run = await until(async () => {
      const r = (await api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`)).body;
      return r.status === "done" || r.status === "failed" ? r : undefined;
    });
    expect(run.status).toBe("done");

    // The agent worked on the merge commit, saw the diff of the merge, and was told what was wrong the first time.
    const prompts = claude.calls().map((c) => c.prompt);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("merged");
    expect(prompts[0]).toContain("checkRateLimit(user);");
    expect(prompts[1]).toContain("not valid JSON");
    expect(created.body.base_commit).toBe(merge);

    expect(gh.pulls).toHaveLength(1);
    const pr = gh.pulls[0]!;
    expect(pr).toMatchObject({ repo: "acme/widgets", base: "main", draft: true, title: "docs(specs): addendum for acme/widgets#7" });
    expect(pr.head).toMatch(/^navarch\/.+\/spec-sync$/);
    expect(pr.body).toContain("🟢 confirmed: 1");
    expect(pr.body).toContain("Claims that may no longer hold: 1 (and 1 the agent named that the specs do not have)");

    // Only the addendum is added; the spec file is untouched.
    expect(git(bare, "diff", "--name-status", "main", pr.head)).toBe("A\t.navarch/specs/addenda/pr-7.md");
    const addendum = git(bare, "show", `${pr.head}:.navarch/specs/addenda/pr-7.md`);
    expect(addendum).toContain("- 🟢 **login-rate-limit** (added) login is refused after too many attempts — `src/auth.ts:3`");
    expect(addendum).toContain("- 🟡 **plain-login-gone** (removed)");
    expect(addendum).toContain("lowered: no evidence given");
    expect(addendum).toContain("- `auth/rejects-empty` — empty users now hit the rate limit first");
    expect(addendum).toContain("## Named, but not found in the specs");
    expect(addendum).toContain("- `auth/does-not-exist`");

    const events = (await api<NavarchEvent[]>("GET", `/api/v1/runs/${created.body.id}/events`)).body;
    expect(events.find((e) => e.type === "spec.addendum.written")!.payload).toMatchObject({ pr_number: 7, changes: 2, confirmed: 1, inferred: 1, downgraded: 1, stale: 1, unmatched: 1 });
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("refuses a pull request that is not merged", async () => {
    const { repo, api, gh } = await setup();
    const refused = await api<{ message: string }>("POST", "/api/v1/runs", { repo_path: repo, flow: "spec-sync", pull_request: "acme/widgets#8" });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain("not merged");
    expect(gh.pulls).toHaveLength(0);
  });
});
