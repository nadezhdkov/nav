import type { ApprovalView, RunView, VectrEvent } from "@vectr/contracts";
import { describe, expect, it } from "vitest";
import { formatApprovals, formatEvent, formatRunList } from "../src/format.ts";

function run(prompt: string): RunView {
  return {
    id: "run_1",
    status: "executing",
    repo_path: "/repo",
    base_commit: "abc",
    prompt,
    budget: 5,
    cost_total: 0,
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
    } as unknown as VectrEvent;
    expect(formatEvent(event).split("\n")).toHaveLength(1);
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
      summary: "Push vectr/run_1/implement and open a draft PR on acme/widgets for issue #7.",
      status: "pending",
      decision_reason: null,
      created_at: "2026-10-14T19:34:47.558Z",
      decided_at: null,
    };
    const out = formatApprovals([a]);
    expect(out).toContain("apr_1");
    expect(out).toContain("open a draft PR on acme/widgets");
    expect(out).toContain("vectr approve apr_1");
    expect(formatApprovals([])).toBe("no pending approvals");
  });

  it("summarises verification and PR events", () => {
    const event = (type: string, payload: unknown) => ({ type, payload, ts: "2026-10-14T19:34:47.558Z" }) as unknown as VectrEvent;
    expect(formatEvent(event("verification.completed", { passed: false, checks: [{}, {}], blocking_failures: ["test: exit 1"], warnings: [] }))).toContain(
      "failed: test: exit 1",
    );
    expect(formatEvent(event("github.pr.opened", { url: "https://github.com/acme/widgets/pull/100", draft: true }))).toContain("draft https://github.com/acme/widgets/pull/100");
  });
});
