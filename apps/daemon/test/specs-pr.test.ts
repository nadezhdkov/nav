import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalView, NavarchEvent, ProjectView, RunDetail, RunView } from "@navarch/contracts";
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

/** A clone of acme/widgets with src/auth.ts, a bare "GitHub" remote and the fake API. */
async function setup() {
  const repo = makeRepo();
  git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "auth.ts"), ["export function login(user: string) {", "  if (!user) throw new Error('missing user');", "  return createSession(user);", "}"].join("\n"));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "add auth");
  const gitUrl = mkdtempSync(join(tmpdir(), "navarch-remote-"));
  mkdirSync(join(gitUrl, "acme"));
  const bare = join(gitUrl, "acme", "widgets.git");
  execFileSync("git", ["clone", "-q", "--bare", repo, bare]);
  const gh = await fakeGitHub();
  servers.push(gh);
  gh.repos.set("acme/widgets", { default_branch: "main", issues: new Map() });

  const home = tempHome();
  const daemon = new Daemon({
    home,
    config: Config.parse({ daemon: { port: 0 }, routing: { enabled: false }, github: { api_url: gh.apiUrl, git_url: gitUrl }, inbox: { poll_minutes: 0 } }),
    adapters: { "claude-code": fakeClaude("specs").options },
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
  return { repo, bare, gh, api, until };
}

describe("PR for the specs (ADR 0048)", () => {
  it("waits for approval, then pushes the specs branch and opens a draft PR with the coverage", async () => {
    const { repo, bare, gh, api, until } = await setup();
    await api<ProjectView>("POST", "/api/v1/projects", { path: repo });
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "document src/auth.ts", flow: "reverse-spec" });
    expect(created.status).toBe(201);

    const approval = await until(async () => (await api<ApprovalView[]>("GET", "/api/v1/approvals?status=pending")).body[0]);
    expect(approval).toMatchObject({ run_id: created.body.id, action: "github.pr.create" });
    expect(approval.summary).toContain("adding 3 file(s) under .navarch/specs/");
    expect(gh.pulls).toHaveLength(0);
    await api("POST", `/api/v1/approvals/${approval.id}`, { decision: "approve" });

    const run = await until(async () => {
      const r = (await api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`)).body;
      return r.status === "done" || r.status === "failed" ? r : undefined;
    });
    expect(run.status).toBe("done");
    expect(run.pr_url).toBeTruthy();

    expect(gh.pulls).toHaveLength(1);
    const pr = gh.pulls[0]!;
    expect(pr).toMatchObject({ repo: "acme/widgets", base: "main", draft: true });
    expect(pr.head).toMatch(/^navarch\/.+\/reverse-spec$/);
    expect(pr.title).toBe("docs(specs): verified specs for auth");
    expect(pr.body).toContain("🟢 confirmed: 1 (33 %)");
    expect(pr.body).toContain("lowered after the evidence check");
    expect(pr.body).toContain("[Authentication](auth.md)");
    expect(git(bare, "show", `${pr.head}:.navarch/specs/auth.md`)).toContain("- 🟢 **rejects-empty**");

    const events = (await api<NavarchEvent[]>("GET", `/api/v1/runs/${created.body.id}/events`)).body;
    expect(events.filter((e) => e.type === "github.pr.opened")).toHaveLength(1);
  });

  it("refuses to start without a registered project, and open_pr=false keeps the specs local", async () => {
    const { repo, gh, api, until } = await setup();
    const refused = await api<{ message: string }>("POST", "/api/v1/runs", { repo_path: repo, prompt: "document src/auth.ts", flow: "reverse-spec" });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain("needs a registered project");

    const local = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "document src/auth.ts", flow: "reverse-spec", params: { open_pr: false } });
    expect(local.status).toBe(201);
    const run = await until(async () => {
      const r = (await api<RunDetail>("GET", `/api/v1/runs/${local.body.id}`)).body;
      return r.status === "done" || r.status === "failed" ? r : undefined;
    });
    expect(run.status).toBe("done");
    expect(gh.pulls).toHaveLength(0);
  });
});
