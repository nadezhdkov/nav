import type { InboxItemView } from "@navarch/contracts";
import { describe, expect, it } from "vitest";
import { filterItems, quotaRows, sortItems, startable, totalEstimate } from "../src/lib/inbox.ts";

function item(n: number, over: Partial<InboxItemView> = {}): InboxItemView {
  return {
    id: `wi_${n}`,
    project_id: "prj_a",
    source: "github",
    repo: "acme/w",
    number: n,
    url: `https://github.com/acme/w/issues/${n}`,
    title: `Issue ${n}`,
    labels: [],
    author: "a",
    status: "triaged",
    triage: null,
    triage_model: null,
    estimate: null,
    runs: [],
    updated_at: `2026-10-0${n}T00:00:00Z`,
    ...over,
  };
}
const triage = (action: "start_run" | "needs_info" | "duplicate" | "skip", complexity: number) =>
  ({ kind: "bug", complexity, area: "x", duplicate_of: null, suggested_action: action, reason: "r" }) as const;

describe("Inbox list helpers", () => {
  it("sorts by suggested action, then simplest first, untriaged last", () => {
    const items = [item(1), item(2, { triage: triage("needs_info", 1) }), item(3, { triage: triage("start_run", 3) }), item(4, { triage: triage("start_run", 1) })];
    expect(sortItems(items).map((i) => i.number)).toEqual([4, 3, 2, 1]);
  });

  it("filters open items by project, kind, action and text", () => {
    const items = [item(1, { status: "new" }), item(2, { status: "dismissed" }), item(3, { project_id: "prj_b", triage: triage("skip", 2) }), item(4, { title: "Crash on save" })];
    const all = { project: "", status: "open" as const, kind: "", action: "", text: "" };
    expect(filterItems(items, all).map((i) => i.number)).toEqual([1, 3, 4]);
    expect(filterItems(items, { ...all, project: "prj_b" }).map((i) => i.number)).toEqual([3]);
    expect(filterItems(items, { ...all, action: "skip" }).map((i) => i.number)).toEqual([3]);
    expect(filterItems(items, { ...all, text: "crash" }).map((i) => i.number)).toEqual([4]);
    expect(filterItems(items, { ...all, text: "#1" }).map((i) => i.number)).toEqual([1]);
    expect(filterItems(items, { ...all, status: "dismissed" }).map((i) => i.number)).toEqual([2]);
  });

  it("adds the known estimates and counts the items without one", () => {
    expect(totalEstimate([item(1, { estimate: { usd: 0.4, runs: 3 } }), item(2, { estimate: { usd: 0.8, runs: 5 } }), item(3)])).toEqual({ usd: 1.2000000000000002, known: 2, unknown: 1 });
  });

  it("starts runs only from items not in a run and not closed", () => {
    expect([item(1, { status: "in_run" }), item(2, { status: "closed" }), item(3, { status: "done" })].map(startable)).toEqual([false, false, true]);
  });

  it("groups quota windows by adapter", () => {
    const q = (adapter: string, window: string) => ({ adapter, window, utilization: 0.5, resets_at: null, exhausted: false, model_prefix: null, observed_at: "x" });
    expect(quotaRows([q("claude-code", "five_hour"), q("codex", "primary"), q("claude-code", "seven_day")])).toEqual([
      { adapter: "claude-code", windows: [q("claude-code", "five_hour"), q("claude-code", "seven_day")] },
      { adapter: "codex", windows: [q("codex", "primary")] },
    ]);
  });
});
