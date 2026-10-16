import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddProjectResult, GitHubRepoView, RunView } from "@navarch/contracts";
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

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A local "GitHub" for git with acme/widgets as a bare repository, and a fake REST API listing repositories. */
async function start(token?: string) {
  const gh = await fakeGitHub();
  servers.push(gh);
  gh.userRepos = [
    { full_name: "acme/widgets", private: true, description: "Widgets", push: true },
    { full_name: "nadezhdkov/notes", private: false, push: false },
  ];
  const source = makeRepo();
  const gitUrl = mkdtempSync(join(tmpdir(), "navarch-remote-"));
  mkdirSync(join(gitUrl, "acme"));
  execFileSync("git", ["clone", "-q", "--bare", source, join(gitUrl, "acme", "widgets.git")]);
  const home = tempHome();
  const daemon = new Daemon({
    home,
    config: Config.parse({ daemon: { port: 0 }, routing: { enabled: false }, github: { api_url: gh.apiUrl, git_url: gitUrl }, inbox: { poll_minutes: 0 } }),
    adapters: { "claude-code": fakeClaude("edit").options },
    vault: new Vault({ env: { NAVARCH_SECRET_GITHUB_TOKEN: token ?? gh.token } }),
  });
  await daemon.start();
  daemons.push(daemon);
  const apiToken = readFileSync(join(home, "token"), "utf8").trim();
  const api = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(daemon.url + path, {
      method,
      headers: { authorization: `Bearer ${apiToken}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  return { daemon, gh, api, home, source };
}

describe("GitHub repositories for New run (ADR 0026)", () => {
  it("lists the repositories the token reaches, marking the registered ones", async () => {
    const { api, gh } = await start();
    const first = await api<GitHubRepoView[]>("GET", "/api/v1/github/repos");
    expect(first.status).toBe(200);
    expect(first.body).toEqual([
      { repo: "acme/widgets", owner: "acme", private: true, description: "Widgets", default_branch: "main", pushed_at: "2026-01-01T00:00:00Z", can_push: true, project_id: null, path: null },
      { repo: "nadezhdkov/notes", owner: "nadezhdkov", private: false, description: null, default_branch: "main", pushed_at: "2026-01-01T00:00:00Z", can_push: false, project_id: null, path: null },
    ]);
    // A second look within a minute is served from memory; refresh asks GitHub again.
    await api("GET", "/api/v1/github/repos");
    expect(gh.requests.filter((r) => r.path === "/user/repos")).toHaveLength(1);
    await api("GET", "/api/v1/github/repos?refresh=1");
    expect(gh.requests.filter((r) => r.path === "/user/repos")).toHaveLength(2);
  });

  it("clones a repository into the Navarch home, registers it as a project, and starts a run there", async () => {
    const { api, home, source } = await start();
    const cloned = await api<AddProjectResult>("POST", "/api/v1/github/repos/clone", { repo: "acme/widgets" });
    expect(cloned.status).toBe(201);
    const path = join(home, "repos", "acme", "widgets");
    expect(cloned.body).toMatchObject({ repo: "acme/widgets", name: "widgets", path, warnings: [] });
    expect(git(path, "rev-parse", "HEAD")).toBe(git(source, "rev-parse", "HEAD"));
    expect(readFileSync(join(path, ".git", "config"), "utf8")).not.toContain("github_pat");

    const listed = (await api<GitHubRepoView[]>("GET", "/api/v1/github/repos")).body;
    expect(listed[0]).toMatchObject({ repo: "acme/widgets", project_id: cloned.body.id, path });

    // Picking it again returns the same project instead of cloning twice.
    const again = await api<AddProjectResult>("POST", "/api/v1/github/repos/clone", { repo: "acme/widgets" });
    expect(again).toMatchObject({ status: 200, body: { id: cloned.body.id, warnings: [] } });

    const run = await api<RunView>("POST", "/api/v1/runs", { repo_path: path, prompt: "add hello.txt" });
    expect(run.status).toBe(201);
  });

  it("refuses a repository the token does not list, and says when GitHub refuses the token", async () => {
    const { api, home } = await start();
    const unknown = await api<{ error: string; message: string }>("POST", "/api/v1/github/repos/clone", { repo: "evil/elsewhere" });
    expect(unknown.status).toBe(404);
    expect(existsSync(join(home, "repos", "evil"))).toBe(false);
    expect((await api("POST", "/api/v1/github/repos/clone", { repo: "../etc" })).status).toBe(400);

    const denied = await start("github_pat_wrong");
    const res = await denied.api<{ error: string; message: string }>("GET", "/api/v1/github/repos");
    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/Bad credentials/);
  });
});
