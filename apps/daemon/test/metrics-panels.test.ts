import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MetricsView, NewEvent } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeGitHub, type FakeGitHub } from "../../../packages/github/test/fake-github.ts";
import { tempHome } from "../../../packages/runner/test/helpers.ts";
import { costPanel, qualityPanel, windowStart } from "../src/budgets/panels.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { EventStore, type AttemptRecord } from "../src/events/store.ts";
import { PrWatcher } from "../src/github/outcomes.ts";
import { GitHubIntegration } from "../src/github/integration.ts";
import { PolicyEngine } from "../src/policy/engine.ts";
import { Vault } from "../src/vault/vault.ts";

const system = { kind: "system" as const, component: "test" };
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
});

function newStore(): EventStore {
  return new EventStore(join(tempHome(), "db.sqlite"));
}

function seedRun(store: EventStore, id: string, repo: string, profile = "implementer") {
  store.append([
    {
      type: "run.created",
      run_id: id,
      task_id: null,
      actor: system,
      payload: { repo_path: repo, base_commit: "abc", prompt: `Run ${id}`, budget: 2, adapter: "claude-code", profile, allow_commands: [] },
    },
    { type: "task.created", run_id: id, task_id: `${id}_t`, actor: system, payload: { node_id: "implement", type: "agent", profile, adapter: "native", max_attempts: 3 } },
  ]);
}

function spend(store: EventStore, runId: string | null, cost: number, opts: { billing?: "metered" | "plan"; model?: string } = {}) {
  store.append([
    {
      type: "model.call.completed",
      run_id: runId,
      task_id: runId ? `${runId}_t` : null,
      actor: system,
      payload: { model: opts.model ?? "m", tokens_in: 100, tokens_out: 10, cached_tokens: 0, cost, ...(opts.billing ? { billing: opts.billing } : {}) },
    },
  ]);
}

function openPr(store: EventStore, runId: string, number: number, commit: string): void {
  const branch = `navarch/${runId}/fix-issue`;
  store.append([
    { type: "github.push", run_id: runId, task_id: null, actor: system, payload: { repo: "o/acme", branch, commit } },
    { type: "github.pr.opened", run_id: runId, task_id: null, actor: system, payload: { repo: "o/acme", number, url: `https://github.com/o/acme/pull/${number}`, branch, draft: true } },
  ]);
}

function closePr(store: EventStore, runId: string, number: number, merged: boolean, commitsAfter: number | null): void {
  const event: NewEvent = {
    type: "github.pr.closed",
    run_id: runId,
    task_id: null,
    actor: system,
    payload: { repo: "o/acme", number, merged, closed_at: "2026-10-16T12:00:00.000Z", head_sha: "f".repeat(40), commits_after: commitsAfter },
  };
  store.append([event]);
}

function attempt(profile: string, status: "succeeded" | "failed", error_kind: string | null = null): AttemptRecord {
  return {
    ts: new Date().toISOString(),
    run_id: "run_x",
    task_id: "t",
    profile,
    adapter: "claude-code",
    model: null,
    model_id: null,
    status,
    error_kind,
    duration_ms: 1000,
    tokens_in: 1,
    tokens_out: 1,
    cached_tokens: 0,
    cost: 0,
    plan_cost: 0,
    context_tokens: null,
  };
}

describe("cost panel (ADR 0037)", () => {
  it("splits the window's spend by day, project, profile and model, billed apart from plan use", () => {
    const store = newStore();
    store.append([{ type: "project.added", run_id: null, task_id: null, actor: system, payload: { project_id: "prj_1", name: "acme", repo: "o/acme", path: "/acme" } }]);
    seedRun(store, "run_a", "/acme");
    seedRun(store, "run_b", "/acme", "reviewer");
    seedRun(store, "run_c", "/elsewhere");
    spend(store, "run_a", 0.3, { billing: "plan", model: "sonnet" });
    spend(store, "run_b", 0.1, { model: "sonnet" });
    spend(store, "run_c", 0.05, { model: "grok" });
    spend(store, null, 0.01, { model: "triage" });

    const now = Date.now();
    const from = windowStart(now, 7).toISOString();
    const panel = costPanel(store.ledgerSince(from), { now, days: 7, projects: store.listProjects() });

    expect(panel.total).toEqual({ cost: 0.16, plan_cost: 0.3, tokens: 440 });
    expect(panel.days).toHaveLength(7);
    expect(panel.days.slice(0, 6).every((d) => d.cost === 0 && d.tokens === 0)).toBe(true);
    expect(panel.days[6]).toMatchObject({ cost: 0.16, plan_cost: 0.3 });
    expect(panel.projects).toEqual([
      { kind: "project", project_id: "prj_1", label: "acme", runs: 2, cost: 0.1, plan_cost: 0.3, tokens: 220 },
      { kind: "repo", project_id: null, label: "/elsewhere", runs: 1, cost: 0.05, plan_cost: 0, tokens: 110 },
      { kind: "outside", project_id: null, label: "outside runs", runs: 0, cost: 0.01, plan_cost: 0, tokens: 110 },
    ]);
    expect(panel.profiles.map((p) => [p.profile, p.cost, p.plan_cost, p.tasks])).toEqual([
      ["implementer", 0.05, 0.3, 2],
      ["reviewer", 0.1, 0, 1],
      [null, 0.01, 0, 0],
    ]);
    expect(panel.models.map((m) => [m.model, m.calls])).toEqual([
      ["sonnet", 2],
      ["grok", 1],
      ["triage", 1],
    ]);
  });

  it("starts the window at local midnight, days - 1 days back", () => {
    const now = new Date(2026, 9, 16, 15, 30).getTime();
    expect(windowStart(now, 1)).toEqual(new Date(2026, 9, 16));
    expect(windowStart(now, 30)).toEqual(new Date(2026, 8, 17));
  });
});

describe("pull request outcomes (ADR 0037)", () => {
  it("tracks Navarch's last push to a PR's branch and how it closed, the same after a replay", () => {
    const store = newStore();
    seedRun(store, "run_a", "/acme");
    openPr(store, "run_a", 7, "a".repeat(40));
    expect(store.openPullRequests()).toEqual([expect.objectContaining({ number: 7, commit_sha: "a".repeat(40), state: "open", run_name: expect.any(String) })]);
    // A retry pushes again: the PR is compared with the newer commit.
    store.append([{ type: "github.push", run_id: "run_a", task_id: null, actor: system, payload: { repo: "o/acme", branch: "navarch/run_a/fix-issue", commit: "b".repeat(40) } }]);
    expect(store.openPullRequests()[0]!.commit_sha).toBe("b".repeat(40));
    closePr(store, "run_a", 7, true, 0);
    expect(store.openPullRequests()).toEqual([]);
    const after = store.pullRequestsSince("2000-01-01");
    store.rebuildProjections();
    expect(store.pullRequestsSince("2000-01-01")).toEqual(after);
    expect(after[0]).toMatchObject({ state: "merged", commits_after: 0, commit_sha: "b".repeat(40) });
  });

  it("fills the table from the log when an older database opens without it", () => {
    const path = join(tempHome(), "db.sqlite");
    const store = new EventStore(path);
    seedRun(store, "run_a", "/acme");
    openPr(store, "run_a", 7, "a".repeat(40));
    store.db.exec("DROP TABLE pull_requests");
    store.close();
    expect(new EventStore(path).openPullRequests()).toEqual([expect.objectContaining({ number: 7, commit_sha: "a".repeat(40) })]);
  });

  it("rates acceptance, PRs taken as they were, rework and cost per merged PR", () => {
    const store = newStore();
    for (const [i, outcome] of (
      [
        [true, 0],
        [true, 3],
        [false, 1],
        [false, null],
        ["open", null],
      ] as const
    ).entries()) {
      const run = `run_${i}`;
      seedRun(store, run, "/acme");
      spend(store, run, 0.2, { billing: "plan" });
      spend(store, run, 0.1);
      openPr(store, run, 10 + i, "a".repeat(40));
      if (outcome[0] !== "open") closePr(store, run, 10 + i, outcome[0], outcome[1]);
    }
    const prs = qualityPanel([], store.pullRequestsSince("2000-01-01"), []).pull_requests;
    expect(prs).toMatchObject({
      opened: 5,
      open: 1,
      merged: 2,
      closed: 2,
      gone: 0,
      acceptance_rate: 0.5,
      accepted_as_is: 1,
      rework: 1,
      // Three closed PRs were compared; the fourth's commits are unknown.
      rework_rate: 0.333,
      cost_per_merged: 0.3,
    });
    expect(prs.recent).toHaveLength(5);
    expect(prs.recent[0]).toMatchObject({ number: 14, state: "open", cost: 0.1, plan_cost: 0.2 });
  });

  it("has no rates before any PR closes", () => {
    expect(qualityPanel([], [], []).pull_requests).toMatchObject({ opened: 0, acceptance_rate: null, rework_rate: null, cost_per_merged: null });
  });

  it("rates success per profile, leaving rate limits and cancellations out", () => {
    const profiles = qualityPanel(
      [
        attempt("implementer", "succeeded"),
        attempt("implementer", "failed", "fatal"),
        attempt("implementer", "failed", "rate_limited"),
        attempt("implementer", "failed", "cancelled"),
        attempt("reviewer", "succeeded"),
      ],
      [],
      [],
    ).profiles;
    expect(profiles).toEqual([
      { profile: "implementer", tasks: 4, succeeded: 1, success_rate: 0.5, rate_limited: 1 },
      { profile: "reviewer", tasks: 1, succeeded: 1, success_rate: 1, rate_limited: 0 },
    ]);
  });
});

describe("PR watcher (ADR 0037)", () => {
  async function setup(): Promise<{ store: EventStore; gh: FakeGitHub; watcher: PrWatcher }> {
    const gh = await fakeGitHub();
    closers.push(gh.close);
    gh.repos.set("o/acme", { default_branch: "main", issues: new Map() });
    const config = Config.parse({ github: { api_url: gh.apiUrl } });
    const vault = new Vault({ env: { NAVARCH_SECRET_GITHUB_TOKEN: gh.token } });
    const store = newStore();
    const watcher = new PrWatcher({ config, store, github: new GitHubIntegration(config, vault, new PolicyEngine()) });
    return { store, gh, watcher };
  }

  const pull = (over: Partial<Parameters<FakeGitHub["pullRequests"]["set"]>[1]>) => ({
    title: "fix",
    body: null,
    author: "navarch",
    head_ref: "navarch/x",
    head_sha: "a".repeat(40),
    base_ref: "main",
    base_sha: "0".repeat(40),
    ...over,
  });

  it("records how a PR closed and the commits added after Navarch's push, then stops reading it", async () => {
    const { store, gh, watcher } = await setup();
    for (const [i, n] of [21, 22, 23].entries()) {
      seedRun(store, `run_${i}`, "/acme");
      openPr(store, `run_${i}`, n, "a".repeat(40));
    }
    gh.pullRequests.set("o/acme#21", pull({ state: "open" }));
    gh.pullRequests.set("o/acme#22", pull({ state: "closed", merged: true, closed_at: "2026-10-16T10:00:00Z", head_sha: "c".repeat(40) }));
    gh.compares.set(`o/acme:${"a".repeat(40)}...${"c".repeat(40)}`, 3);
    gh.pullRequests.set("o/acme#23", pull({ state: "closed", merged: false }));

    expect(await watcher.check()).toBe(2);
    const byNumber = Object.fromEntries(store.pullRequestsSince("2000-01-01").map((p) => [p.number, p]));
    expect(byNumber[21]).toMatchObject({ state: "open", commits_after: null });
    expect(byNumber[22]).toMatchObject({ state: "merged", commits_after: 3, closed_at: "2026-10-16T10:00:00Z" });
    expect(byNumber[23]).toMatchObject({ state: "closed", commits_after: 0 });

    gh.requests.length = 0;
    await watcher.check();
    expect(gh.requests.map((r) => r.path)).toEqual(["/repos/o/acme/pulls/21"]);
  });

  it("gives up on a PR that is not found three polls in a row", async () => {
    const { store, watcher } = await setup();
    seedRun(store, "run_a", "/acme");
    openPr(store, "run_a", 31, "a".repeat(40));
    await watcher.check();
    await watcher.check();
    expect(store.openPullRequests()).toHaveLength(1);
    await watcher.check();
    expect(store.openPullRequests()).toHaveLength(0);
    expect(store.pullRequestsSince("2000-01-01")[0]).toMatchObject({ state: "gone" });
    expect(store.events({ runId: "run_a" }).map((e) => e.type)).toContain("github.pr.lost");
  });
});

describe("GET /api/v1/metrics", () => {
  it("serves both panels and refuses a window outside 1–365 days", async () => {
    const home = tempHome();
    const daemon = new Daemon({ home, config: Config.parse({ daemon: { port: 0 }, routing: { enabled: false } }) });
    await daemon.start();
    closers.push(() => daemon.stop());
    seedRun(daemon.store, "run_a", "/acme");
    spend(daemon.store, "run_a", 0.25);
    const token = readFileSync(join(home, "token"), "utf8").trim();
    const get = async (path: string) => {
      const res = await fetch(daemon.url + path, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, body: (await res.json()) as MetricsView };
    };
    const ok = await get("/api/v1/metrics?days=7");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ window_days: 7, cost: { total: { cost: 0.25 } }, quality: { pull_requests: { opened: 0 } } });
    expect(ok.body.cost.days).toHaveLength(7);
    expect((await get("/api/v1/metrics")).body.window_days).toBe(30);
    expect((await get("/api/v1/metrics?days=366")).status).toBe(400);
  });
});
