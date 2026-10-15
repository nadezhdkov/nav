import type { ApprovalView, DeviceView, InboxView, RunView, NavarchEvent } from "@navarch/contracts";
import { describe, expect, it } from "vitest";
import { formatApprovals, formatBudgets, formatDevices, formatEvent, formatGitHubRepos, formatInbox, formatRemote, formatRunList, formatSync, formatUsage } from "../src/format.ts";

function run(prompt: string): RunView {
  return {
    id: "run_1",
    status: "executing",
    repo_path: "/repo",
    base_commit: "abc",
    prompt,
    budget: 5,
    cost_total: 0,
    plan_cost: 0,
    created_at: "2026-10-14T19:34:47.558Z",
    updated_at: "2026-10-14T19:34:47.558Z",
  } as RunView;
}

describe("formatRunList", () => {
  it("keeps one row per run when the prompt has several lines", () => {
    const out = formatRunList([run("first line\nsecond line"), run("other")]);
    expect(out.split("\n")).toHaveLength(3);
    expect(out).toContain("first line");
    expect(out).not.toContain("second line");
  });

  it("shows an Agent Brief by its Summary line", () => {
    const brief = "## Agent Brief\n\n**Category:** bug\n**Summary:** Fix the slug fallback\n\n**Current behavior:**\n…";
    expect(formatRunList([run(brief)])).toContain("Fix the slug fallback");
  });
});

describe("formatEvent", () => {
  it("keeps a multi-line status reason on one line", () => {
    const event = {
      ts: "2026-10-14T19:36:14.000Z",
      type: "task.status_changed",
      payload: { from: "running", to: "failed", reason: "boom\n    at frame (file.js:1:1)" },
    } as unknown as NavarchEvent;
    expect(formatEvent(event).split("\n")).toHaveLength(1);
  });

  it("shows instructions and where they went", () => {
    const sent = { ts: "2026-10-15T01:00:00.000Z", type: "run.message", payload: { message_id: "msg_1", text: "use\npnpm", delivery: "now", task_id: "task_1" } };
    expect(formatEvent(sent as unknown as NavarchEvent)).toContain("msg_1 now → task_1: use pnpm");
    const delivered = { ts: "2026-10-15T01:00:01.000Z", type: "run.message.delivered", payload: { message_id: "msg_1", task_id: "task_1", attempt: 2 } };
    expect(formatEvent(delivered as unknown as NavarchEvent)).toContain("msg_1 → task_1 attempt 2");
  });
});

describe("Phase 1 output", () => {
  it("names an issue run by its issue", () => {
    const r = { ...run("Resolve GitHub issue acme/widgets#7 (https://github.com/acme/widgets/issues/7).\n\n…"), work_item: { source: "github", repo: "acme/widgets", number: 7, url: "u" } } as RunView;
    expect(formatRunList([r])).toContain("acme/widgets#7");
  });

  it("lists pending approvals with the command to decide them", () => {
    const a: ApprovalView = {
      id: "apr_1",
      run_id: "run_1",
      task_id: "task_3",
      action: "github.pr.create",
      resource: "task_3",
      reason: "opening a PR requires approval below autonomy level 3",
      summary: "Push navarch/run_1/implement and open a draft PR on acme/widgets for issue #7.",
      status: "pending",
      decision_reason: null,
      created_at: "2026-10-14T19:34:47.558Z",
      decided_at: null,
    };
    const out = formatApprovals([a]);
    expect(out).toContain("apr_1");
    expect(out).toContain("open a draft PR on acme/widgets");
    expect(out).toContain("navarch approve apr_1");
    expect(formatApprovals([])).toBe("no pending approvals");
    // A plan keeps its lines while it waits for a decision.
    const plan = formatApprovals([{ ...a, action: "flow.approval", summary: "Review:\n# Plan\n- add hello.txt" }]);
    expect(plan).toContain("\n  # Plan\n  - add hello.txt");
  });

  it("summarises verification and PR events", () => {
    const event = (type: string, payload: unknown) => ({ type, payload, ts: "2026-10-14T19:34:47.558Z" }) as unknown as NavarchEvent;
    expect(formatEvent(event("verification.completed", { passed: false, checks: [{}, {}], blocking_failures: ["test: exit 1"], warnings: [] }))).toContain(
      "failed: test: exit 1",
    );
    expect(formatEvent(event("github.pr.opened", { url: "https://github.com/acme/widgets/pull/100", draft: true }))).toContain("draft https://github.com/acme/widgets/pull/100");
  });
});

describe("remote and devices (ADR 0020)", () => {
  const base = { mode: "tailscale", installed: true, running: true, url: "https://pc.tail.ts.net", serving: false, setup_command: "tailscale serve --bg 7420" } as const;

  it("says what is missing for the phone to reach the daemon", () => {
    expect(formatRemote(base)).toContain("not set up; run: tailscale serve --bg 7420");
    expect(formatRemote({ ...base, serving: true })).toContain("Pair a phone");
    expect(formatRemote({ ...base, installed: false, running: false, url: null })).toContain("not installed");
    expect(formatRemote({ ...base, mode: "off" })).toContain("remote access is off");
  });

  it("lists paired devices with their state", () => {
    const d: DeviceView = { id: "dev_1", name: "Pixel", paired_at: "2026-10-15T10:00:00Z", last_seen_at: null, revoked_at: null, push: true };
    expect(formatDevices([d])).toBe("dev_1  Pixel  paired 2026-10-15  last seen never  push on");
    expect(formatDevices([{ ...d, revoked_at: "2026-10-16T08:30:00Z", push: false }])).toContain("revoked 2026-10-16 08:30");
    expect(formatDevices([])).toContain("no paired devices");
  });
});

describe("formatInbox", () => {
  const view: InboxView = {
    triage: { available: false, reason: "no API model for triage", used_today: { items: 0, usd: 0 }, cap: { items: 50, usd: 0.5 } },
    items: [
      {
        id: "wi_github_acme~w_1",
        project_id: "prj_1",
        source: "github",
        repo: "acme/w",
        number: 1,
        url: "https://github.com/acme/w/issues/1",
        title: "Crash\non empty input",
        labels: [],
        author: "a",
        status: "triaged",
        triage: { kind: "bug", complexity: 2, area: "cli", duplicate_of: 4, suggested_action: "duplicate", reason: "r" },
        triage_model: "m",
        estimate: { usd: 0.42, runs: 5 },
        runs: [],
        updated_at: "2026-10-15T00:00:00Z",
      },
    ],
  };

  it("puts each item on one line with its triage and estimate, and says why triage is off", () => {
    const out = formatInbox(view);
    expect(out).toContain("triage: no API model for triage");
    const row = out.split("\n").find((l) => l.startsWith("wi_github_acme~w_1"))!;
    expect(row).toMatch(/acme\/w#1\s+triaged\s+bug\s+2\s+cli\s+duplicate of #4\s+\$0.4200\s+Crash on empty input/);
  });

  it("reports each project's sync", () => {
    expect(formatSync([{ project_id: "p", new: 2, changed: 1, closed: 0, not_modified: false }, { project_id: "q", new: 0, changed: 0, closed: 0, not_modified: false, error: "rate limit" }])).toBe(
      "p: 2 new, 1 changed, 0 closed\nq: failed: rate limit",
    );
  });
});

describe("budgets and usage (ADR 0023)", () => {
  it("shows billed use against each limit and how to change one", () => {
    const text = formatBudgets([
      { scope: "global_monthly", target: null, label: "global", period: "2026-10", limit: 100, source: "config", used: 85, plan_equivalent: 12.5, ratio: 0.85, state: "warning" },
      { scope: "project_daily", target: "prj_1", label: "acme", period: "2026-10-15", limit: null, source: "config", used: 0.25, plan_equivalent: 0, ratio: null, state: "ok" },
      { scope: "run", target: "run_1", label: "Fix it", period: "run_1", limit: 2, source: "run", used: 2.1, plan_equivalent: 0, ratio: 1.05, state: "exceeded" },
    ]);
    expect(text).toContain("global · 2026-10");
    expect(text).toMatch(/\$85\.00 of \$100\.00 · 85 %\s+warning\s+\$12\.50/);
    expect(text).toContain("$0.2500 (no limit)");
    expect(text).toMatch(/run run_1\s+\$2\.10 of \$2\.00 · 105 %\s+EXCEEDED/);
    expect(text).toContain("navarch budget set --monthly");
  });

  it("shows spend, tokens and per-model metrics", () => {
    const text = formatUsage({
      generated_at: "2026-10-15T12:00:00Z",
      window_days: 30,
      today: { cost: 0.5, plan_cost: 3, tokens: 12_345 },
      month: { cost: 4, plan_cost: 40, tokens: 2_500_000 },
      budgets: [],
      models: [
        {
          id: "claude-code",
          adapter: "claude-code",
          model: null,
          billing: "plan",
          profile: null,
          tasks: 10,
          succeeded: 9,
          success_rate: 0.9,
          error_rate_24h: null,
          tokens_in: 900_000,
          tokens_out: 40_000,
          cached_tokens: 0,
          median_tokens_per_success: 80_000,
          cost: 0,
          plan_cost: 12,
          median_cost_per_success: 1.2,
          p50_duration_ms: 95_000,
        },
      ],
      quotas: [{ adapter: "claude-code", window: "five_hour", utilization: 0.4, resets_at: "2026-10-15T18:00:00Z", exhausted: false, model_prefix: null, observed_at: "2026-10-15T11:00:00Z" }],
    });
    expect(text).toContain("today       $0.5000 billed · $3.00 plan-equivalent · 12.3k tokens");
    expect(text).toContain("2.5M tokens");
    expect(text).toMatch(/claude-code\s+plan\s+10\s+90 %\s+-\s+900\.0k\/40\.0k\s+80\.0k\s+\$1\.20\s+\$0\.00\s+95s/);
    expect(text).toContain("claude-code five_hour: 40 %, resets 2026-10-15 18:00");
  });
});

describe("formatGitHubRepos", () => {
  it("lists repositories with visibility, push access and project", () => {
    const out = formatGitHubRepos([
      { repo: "acme/widgets", owner: "acme", private: true, description: "Widgets", default_branch: "main", pushed_at: null, can_push: true, project_id: "prj_1", path: "/x" },
      { repo: "me/notes", owner: "me", private: false, description: null, default_branch: "main", pushed_at: null, can_push: false, project_id: null, path: null },
    ]);
    expect(out).toContain("acme/widgets");
    expect(out).toMatch(/acme\/widgets\s+private\s+yes\s+prj_1\s+Widgets/);
    expect(out).toMatch(/me\/notes\s+public\s+no\s+-/);
    expect(formatGitHubRepos([])).toMatch(/reaches no repositories/);
  });
});
