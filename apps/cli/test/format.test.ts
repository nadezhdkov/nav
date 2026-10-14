import type { RunView, VectrEvent } from "@vectr/contracts";
import { describe, expect, it } from "vitest";
import { formatEvent, formatRunList } from "../src/format.ts";

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
