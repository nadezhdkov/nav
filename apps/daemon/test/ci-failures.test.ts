import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CiFailureView, NavarchEvent, ProjectView, RunDetail } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { fakeGitHub, type FakeGitHub } from "../../../packages/github/test/fake-github.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { noticeFor } from "../src/notifications/notifier.ts";
import { Vault } from "../src/vault/vault.ts";

const daemons: Daemon[] = [];
const servers: FakeGitHub[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
  for (const s of servers.splice(0)) await s.close();
});

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();

/**
 * A clone of acme/widgets with a bare "GitHub" remote. `addPr` pushes a branch to
 * `refs/pull/<n>/head` and registers the pull request with the fake API, so a `ci-fix` run can
 * fetch it; its checks are set by the test.
 */
async function setup(config: Record<string, unknown> = {}) {
  const repo = makeRepo();
  git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  mkdirSync(join(repo, ".navarch"));
  writeFileSync(join(repo, ".navarch", "project.yaml"), "verify:\n  - name: greeting\n    run: test -f hello.txt\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "navarch project config");
  const base = git(repo, "rev-parse", "HEAD");
  const gitUrl = mkdtempSync(join(tmpdir(), "navarch-remote-"));
  mkdirSync(join(gitUrl, "acme"));
  const bare = join(gitUrl, "acme", "widgets.git");
  execFileSync("git", ["clone", "-q", "--bare", repo, bare]);
  const author = mkdtempSync(join(tmpdir(), "navarch-pr-author-"));
  execFileSync("git", ["clone", "-q", bare, author]);

  const gh = await fakeGitHub();
  servers.push(gh);
  gh.repos.set("acme/widgets", { default_branch: "main", issues: new Map() });

  /** Pushes a new commit on `branch` as the head of pull request `number`. */
  const addPr = (number: number, branch: string, over: { head_repo?: string; draft?: boolean; checks?: { name: string; conclusion: string | null; status?: string }[] } = {}) => {
    git(author, "switch", "-q", "-C", branch, "origin/main");
    writeFileSync(join(author, `pr-${number}.txt`), `${branch} ${Math.random()}\n`);
    git(author, "add", ".");
    git(author, "commit", "-q", "-m", branch);
    git(author, "push", "-q", "-f", "origin", `${branch}:${branch}`, `HEAD:refs/pull/${number}/head`);
    const head = git(author, "rev-parse", "HEAD");
    gh.pullRequests.set(`acme/widgets#${number}`, {
      title: `PR ${number}`,
      body: "body",
      author: "erin",
      head_ref: branch,
      head_sha: head,
      ...(over.head_repo ? { head_repo: over.head_repo } : {}),
      ...(over.draft ? { draft: true } : {}),
      base_ref: "main",
      base_sha: base,
    });
    const checks = over.checks ?? [{ name: "test", conclusion: "failure" }];
    gh.checks.set(head, checks.map((c, i) => ({ id: number * 100 + i, name: c.name, conclusion: c.conclusion, ...(c.status ? { status: c.status } : {}), actions: true, log: `${c.name} failed\n` })));
    return head;
  };

  const home = tempHome();
  const daemon = new Daemon({
    home,
    config: Config.parse({ daemon: { port: 0 }, routing: { enabled: false }, github: { api_url: gh.apiUrl, git_url: gitUrl }, inbox: { poll_minutes: 0 }, ...config }),
    adapters: { "claude-code": fakeClaude("pulls").options },
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
  const project = (await api<ProjectView>("POST", "/api/v1/projects", { path: repo })).body;
  const failures = async (status = "") => (await api<CiFailureView[]>("GET", `/api/v1/ci/failures${status ? `?status=${status}` : ""}`)).body;
  return { daemon, gh, api, addPr, project, failures };
}

describe("CI failure trigger (ADR 0041)", () => {
  it("reports a head whose checks finished with a failure once, with the failed checks", async () => {
    const { daemon, addPr, failures, project } = await setup();
    const head = addPr(12, "feature", { checks: [{ name: "test", conclusion: "failure" }, { name: "lint", conclusion: "success" }, { name: "slow", conclusion: "timed_out" }] });
    expect(await daemon.ci.check()).toBe(1);
    expect(await daemon.ci.check()).toBe(0);
    expect(await failures()).toEqual([
      expect.objectContaining({
        project_id: project.id,
        repo: "acme/widgets",
        number: 12,
        title: "PR 12",
        author: "erin",
        head_ref: "feature",
        head_sha: head,
        status: "open",
        checks: [expect.objectContaining({ name: "test", conclusion: "failure" }), expect.objectContaining({ name: "slow", conclusion: "timed_out" })],
      }),
    ]);
  });

  it("skips forks, Navarch's own fix branches, heads still running checks and heads that pass", async () => {
    const { daemon, addPr, failures, gh } = await setup();
    addPr(1, "from-fork", { head_repo: "eve/widgets" });
    addPr(2, "navarch/run_01ABC/ci-fix");
    addPr(3, "running", { checks: [{ name: "test", conclusion: "failure" }, { name: "e2e", conclusion: null, status: "in_progress" }] });
    addPr(4, "green", { checks: [{ name: "test", conclusion: "success" }] });
    addPr(5, "no-ci", { checks: [] });
    expect(await daemon.ci.check()).toBe(0);
    expect(await failures("")).toEqual([]);
    // Logs are never read while watching.
    expect(gh.requests.some((r) => r.path.includes("/actions/jobs/"))).toBe(false);
  });

  it("resolves a failure when the head moves, the checks pass or the pull request closes, and reports the new head", async () => {
    const { daemon, addPr, failures, gh } = await setup();
    const first = addPr(12, "feature");
    const green = addPr(13, "green-later");
    const closing = addPr(14, "closing");
    await daemon.ci.check();
    expect((await failures()).map((f) => f.number).sort()).toEqual([12, 13, 14]);

    const second = addPr(12, "feature"); // a new commit with failing checks
    gh.checks.set(green, [{ id: 1300, name: "test", conclusion: "success" }]); // rerun passed
    gh.pullRequests.get("acme/widgets#14")!.state = "closed";
    expect(await daemon.ci.check()).toBe(1);

    const all = await failures("resolved");
    expect(all.map((f) => [f.number, f.resolved_reason]).sort()).toEqual([[12, "moved"], [13, "passed"], [14, "closed"]]);
    expect((await failures()).map((f) => [f.number, f.head_sha])).toEqual([[12, second]]);
    expect(first).not.toBe(second);
    expect(closing).toBeTruthy();
  });

  it("dismisses a failure, and a dismissed head is not reported again", async () => {
    const { daemon, api, addPr, failures } = await setup();
    addPr(12, "feature");
    await daemon.ci.check();
    const [failure] = await failures();
    expect((await api<CiFailureView>("POST", `/api/v1/ci/failures/${failure!.id}/dismiss`)).body.status).toBe("dismissed");
    await daemon.ci.check();
    expect(await failures()).toEqual([]);
    expect(await failures("dismissed")).toHaveLength(1);
    expect((await api("POST", "/api/v1/ci/failures/cif_nope/dismiss")).status).toBe(404);
  });

  it("starts a ci-fix run for a failure on request, once", async () => {
    const { daemon, api, addPr, failures } = await setup();
    addPr(12, "feature");
    await daemon.ci.check();
    const [failure] = await failures();
    const started = await api<{ failure: CiFailureView; run: { id: string } }>("POST", `/api/v1/ci/failures/${failure!.id}/fix`, {});
    expect(started.status).toBe(200);
    expect(started.body.failure).toMatchObject({ status: "started", run_id: started.body.run.id });
    const run = (await api<RunDetail>("GET", `/api/v1/runs/${started.body.run.id}`)).body;
    expect(run.flow).toBe("ci-fix");
    expect(run.work_item).toMatchObject({ repo: "acme/widgets", number: 12, kind: "pull_request" });
    expect((await api("POST", `/api/v1/ci/failures/${failure!.id}/fix`, {})).status).toBe(409);
    expect((await api("POST", "/api/v1/ci/failures/cif_nope/fix", {})).status).toBe(404);
    const events = (await api<NavarchEvent[]>("GET", `/api/v1/runs/${started.body.run.id}/events`)).body;
    expect(events.find((e) => e.type === "ci.failure.started")).toMatchObject({ payload: { auto: false } });
  });

  it("starts nothing by itself unless ci_fix.auto is on", async () => {
    const { daemon, addPr, failures } = await setup();
    addPr(12, "feature");
    await daemon.ci.check();
    expect(await failures("started")).toEqual([]);
    expect(daemon.store.listRuns()).toHaveLength(0);
  });

  it("with ci_fix.auto, starts runs itself up to daily_runs and leaves the rest open", async () => {
    const { daemon, addPr, failures } = await setup({ ci_fix: { auto: true, daily_runs: 1 } });
    addPr(12, "feature-a");
    addPr(13, "feature-b");
    expect(await daemon.ci.check()).toBe(2);
    const started = await failures("started");
    expect(started).toHaveLength(1);
    expect((await failures()).length).toBe(1);
    const run = daemon.store.listRuns()[0]!;
    expect(run.id).toBe(started[0]!.run_id);
    const event = daemon.store.db.prepare("SELECT payload FROM events WHERE type = 'ci.failure.started'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ auto: true });
  });

  it("rebuilds the failures from the event log", async () => {
    const { daemon, addPr, failures } = await setup();
    addPr(12, "feature");
    await daemon.ci.check();
    daemon.store.rebuildProjections();
    expect(await failures()).toHaveLength(1);
  });

  it("notifies a new failure with the pull request as the title, not a run", () => {
    const event = {
      type: "ci.failure.detected",
      run_id: null,
      payload: { failure_id: "cif_1", project_id: "p", repo: "acme/widgets", number: 12, title: "Bad\nchange", author: "e", url: "u", head_ref: "f", head_sha: "a", checks: [] },
    } as unknown as NavarchEvent;
    expect(noticeFor(event)).toMatchObject({ kind: "ci_failure", run_id: "cif_1", critical: false, url: "/home", text: "acme/widgets#12 Bad change" });
  });
});
