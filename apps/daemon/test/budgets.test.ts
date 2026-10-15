import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalView, BudgetView, NavarchEvent, RunDetail, RunView, UsageView } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Budgets } from "../src/budgets/budgets.ts";
import { median, modelMetrics, observedFor } from "../src/budgets/metrics.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { EventStore, type AttemptRecord } from "../src/events/store.ts";

const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
});

const system = { kind: "system" as const, component: "test" };

function seedRun(store: EventStore, id: string, repo: string, budget = 2) {
  store.append([
    {
      type: "run.created",
      run_id: id,
      task_id: null,
      actor: system,
      payload: { repo_path: repo, base_commit: "abc", prompt: `Run ${id}`, budget, adapter: "claude-code", profile: "implementer", allow_commands: [] },
    },
    { type: "task.created", run_id: id, task_id: `${id}_t`, actor: system, payload: { node_id: "implement", type: "agent", profile: "implementer", adapter: "native", max_attempts: 3 } },
  ]);
}

function spend(store: EventStore, runId: string, cost: number, billing?: "metered" | "plan") {
  store.append([
    {
      type: "model.call.completed",
      run_id: runId,
      task_id: `${runId}_t`,
      actor: system,
      payload: { model: "m", tokens_in: 100, tokens_out: 10, cached_tokens: 0, cost, ...(billing ? { billing } : {}) },
    },
  ]);
}

describe("Cost Ledger (ADR 0023)", () => {
  it("keeps billed and plan use apart; usage without billing counts as billed", () => {
    const store = new EventStore(join(tempHome(), "db.sqlite"));
    seedRun(store, "run_a", "/r");
    spend(store, "run_a", 0.3, "plan");
    spend(store, "run_a", 0.1, "metered");
    spend(store, "run_a", 0.05);
    const run = store.getRun("run_a")!;
    expect(run.cost_total).toBeCloseTo(0.15);
    expect(run.plan_cost).toBeCloseTo(0.3);
    expect(store.tasksOfRun("run_a")[0]).toMatchObject({ cost: expect.closeTo(0.15), plan_cost: expect.closeTo(0.3) });
    expect(store.usageTotals(null, { runId: "run_a" })).toEqual({ cost: expect.closeTo(0.15), plan_cost: expect.closeTo(0.3), tokens: 330 });
    // Replaying the log gives the same ledger.
    store.rebuildProjections();
    expect(store.getRun("run_a")!.plan_cost).toBeCloseTo(0.3);
    expect(store.usageTotals(null).cost).toBeCloseTo(0.15);
    store.close();
  });

  it("resolves a run's scopes, with project and global limits from config or overrides", () => {
    const store = new EventStore(join(tempHome(), "db.sqlite"));
    const config = Config.parse({ budgets: { project_daily: 1, global_monthly: 10 } });
    const budgets = new Budgets({ store, config });
    store.append([{ type: "project.added", run_id: null, task_id: null, actor: system, payload: { project_id: "prj_1", name: "acme", repo: "o/acme", path: "/acme" } }]);
    seedRun(store, "run_a", "/acme", 0.5);
    seedRun(store, "run_b", "/elsewhere");
    spend(store, "run_a", 0.45);
    spend(store, "run_b", 2, "plan");

    const scopes = budgets.scopesOf(store.getRun("run_a")!);
    expect(scopes.map((s) => [s.scope, s.limit, s.used, s.state])).toEqual([
      ["run", 0.5, 0.45, "warning"],
      ["project_daily", 1, 0.45, "ok"],
      ["global_monthly", 10, 0.45, "ok"],
    ]);
    expect(scopes[2]!.plan_equivalent).toBe(2);
    expect(budgets.remaining(store.getRun("run_a")!)).toBeCloseTo(0.05);
    // A run outside registered projects has no project scope.
    expect(budgets.scopesOf(store.getRun("run_b")!).map((s) => s.scope)).toEqual(["run", "global_monthly"]);

    store.append([budgets.setEvent({ scope: "project_daily", target: "prj_1", usd: 0.4 }, { kind: "user", via: "cli" })]);
    expect(budgets.scopesOf(store.getRun("run_a")!)[1]).toMatchObject({ limit: 0.4, source: "override", state: "exceeded" });
    store.append([budgets.setEvent({ scope: "global_monthly", usd: null }, { kind: "user", via: "cli" })]);
    expect(budgets.scopesOf(store.getRun("run_a")!)[2]).toMatchObject({ limit: null, ratio: null, state: "ok" });
    expect(() => budgets.setEvent({ scope: "project_daily", target: "prj_x", usd: 1 }, { kind: "user", via: "cli" })).toThrow(/unknown project/);
    store.close();
  });

  it("records each threshold once per scope and period", () => {
    const store = new EventStore(join(tempHome(), "db.sqlite"));
    const budgets = new Budgets({ store, config: Config.parse({ budgets: { global_monthly: 1 } }), now: () => Date.parse("2026-10-15T12:00:00") });
    seedRun(store, "run_a", "/r", 5);
    spend(store, "run_a", 0.85);
    const first = budgets.thresholdEvents(store.getRun("run_a")!);
    expect(first.map((e) => [e.payload.scope, e.payload.ratio, e.payload.period])).toEqual([["global_monthly", 0.8, "2026-10"]]);
    store.append(first);
    expect(budgets.thresholdEvents(store.getRun("run_a")!)).toEqual([]);
    spend(store, "run_a", 0.2);
    expect(budgets.thresholdEvents(store.getRun("run_a")!).map((e) => e.payload.ratio)).toEqual([1]);
    store.close();
  });

  it("uses the PC's local day and month", () => {
    const store = new EventStore(join(tempHome(), "db.sqlite"));
    const at = new Date(2026, 9, 1, 0, 30);
    const budgets = new Budgets({ store, config: Config.parse({}), now: () => at.getTime() });
    expect(budgets.day()).toEqual({ from: new Date(2026, 9, 1).toISOString(), period: "2026-10-01" });
    expect(budgets.month()).toEqual({ from: new Date(2026, 9, 1).toISOString(), period: "2026-10" });
    store.close();
  });
});

describe("observed metrics (ADR 0023)", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const attempt = (over: Partial<AttemptRecord>): AttemptRecord => ({
    ts: "2026-10-15T11:00:00Z",
    run_id: "r",
    task_id: "t",
    profile: "implementer",
    adapter: "native",
    model: "openrouter/x",
    model_id: "x",
    status: "succeeded",
    error_kind: null,
    duration_ms: 1000,
    tokens_in: 100,
    tokens_out: 50,
    cached_tokens: 0,
    cost: 0.1,
    plan_cost: 0,
    ...over,
  });

  it("summarizes success, tokens, cost and duration per catalog entry", () => {
    const rows = [
      attempt({ cost: 0.1, duration_ms: 1000 }),
      attempt({ cost: 0.3, tokens_in: 300, duration_ms: 3000 }),
      attempt({ status: "failed", error_kind: "fatal", cost: 0.05, duration_ms: 500 }),
      attempt({ status: "failed", error_kind: "rate_limited", cost: 0, duration_ms: 10 }),
      attempt({ adapter: "claude-code", model: null, model_id: null, cost: 0, plan_cost: 0.4, profile: "reviewer" }),
    ];
    const [x, claude] = modelMetrics(rows, { now, billingOf: () => "plan" });
    expect(x).toMatchObject({
      id: "x",
      billing: "metered",
      tasks: 4,
      succeeded: 2,
      success_rate: 0.667,
      error_rate_24h: null,
      median_tokens_per_success: 250,
      median_cost_per_success: 0.2,
      cost: 0.45,
    });
    expect(claude).toMatchObject({ id: "claude-code", billing: "plan", plan_cost: 0.4, median_cost_per_success: 0.4 });
    expect(modelMetrics(rows, { now, profile: "reviewer", billingOf: () => "plan" }).map((m) => m.id)).toEqual(["claude-code"]);
  });

  it("gives the router an expected cost from 3 succeeded tasks and recent failures", () => {
    const rows = [attempt({ cost: 0.1 }), attempt({ cost: 0.2 })];
    expect(observedFor(rows, now)("x", "implementer")).toEqual({ recent: { failed: 0, total: 2 } });
    rows.push(attempt({ cost: 0.6 }), attempt({ status: "failed", error_kind: "fatal", ts: "2026-10-13T00:00:00Z" }));
    expect(observedFor(rows, now)("x", "implementer")).toEqual({ expectedCost: 0.2, recent: { failed: 0, total: 3 } });
    expect(observedFor(rows, now)("x", "planner")).toEqual({ recent: { failed: 0, total: 3 } });
    expect(observedFor(rows, now)("y", "implementer")).toBeUndefined();
    expect(median([3, 1, 2, 4])).toBe(2.5);
  });
});

describe("navarchd budgets end to end (fake Claude Code on an API key)", () => {
  async function start(home: string) {
    const fake = fakeClaude("edit");
    writeFileSync(join(fake.stateDir, "api-key-source"), "ANTHROPIC_API_KEY");
    const config = Config.parse({ daemon: { port: 0 }, routing: { enabled: false }, budgets: { global_monthly: 0.005 } });
    const daemon = new Daemon({ home, config, adapters: { "claude-code": fake.options } });
    await daemon.start();
    daemons.push(daemon);
    const token = readFileSync(join(home, "token"), "utf8").trim();
    const api = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
      const res = await fetch(daemon.url + path, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: (await res.json()) as T };
    };
    return { daemon, api };
  }

  async function until<T>(fn: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
    const end = Date.now() + 15_000;
    for (;;) {
      const v = await fn();
      if (done(v)) return v;
      if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it("asks before spending beyond a used-up budget and releases the run when it is raised", async () => {
    const { api } = await start(tempHome());
    const repo = makeRepo();
    const first = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "add hello.txt" });
    await until(() => api<RunDetail>("GET", `/api/v1/runs/${first.body.id}`), (r) => r.body.status === "done");
    const events = (await api<NavarchEvent[]>("GET", `/api/v1/runs/${first.body.id}/events`)).body;
    expect(events.filter((e) => e.type === "budget.threshold").map((e) => e.payload)).toEqual([
      expect.objectContaining({ scope: "global_monthly", ratio: 0.8 }),
      expect.objectContaining({ scope: "global_monthly", ratio: 1 }),
    ]);

    const second = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "add hello.txt again" });
    const waiting = await until(() => api<RunDetail>("GET", `/api/v1/runs/${second.body.id}`), (r) => r.body.status === "budget_exceeded");
    expect(waiting.body.tasks[0]?.status).toBe("waiting_approval");
    const [approval] = (await api<ApprovalView[]>("GET", "/api/v1/approvals")).body.filter((a) => a.run_id === second.body.id);
    expect(approval).toMatchObject({ action: "budget.exceed" });
    expect(approval!.summary).toContain("Over budget: global 20");

    const raised = await api<BudgetView[]>("PUT", "/api/v1/budgets", { scope: "global_monthly", usd: 5 });
    expect(raised.body[0]).toMatchObject({ scope: "global_monthly", limit: 5, source: "override", state: "ok" });
    await until(() => api<RunDetail>("GET", `/api/v1/runs/${second.body.id}`), (r) => r.body.status === "done");
    expect((await api<ApprovalView[]>("GET", "/api/v1/approvals?all=1")).body.find((a) => a.id === approval!.id)).toMatchObject({
      status: "approved",
      decision_reason: "budget raised",
    });

    const usage = (await api<UsageView>("GET", "/api/v1/usage?days=7")).body;
    expect(usage.today.cost).toBeCloseTo(0.02);
    expect(usage.models[0]).toMatchObject({ id: "claude-code", billing: "metered", tasks: 2, succeeded: 2 });
    expect((await api<unknown>("GET", "/api/v1/usage?days=0")).status).toBe(400);
    expect((await api<unknown>("PUT", "/api/v1/budgets", { scope: "run", usd: 1 })).status).toBe(400);
  });
});
