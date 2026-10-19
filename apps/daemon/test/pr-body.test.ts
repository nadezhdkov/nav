import { describe, expect, it } from "vitest";
import { prBody } from "../src/orchestrator/issue.ts";

const item = { source: "github", repo: "acme/w", number: 5, url: "https://github.com/acme/w/issues/5", title: "Add notes", body: "", labels: [], author: "alice", updated_at: "t" } as never;
const base = { item, summary: "Added notes.txt.", changedFiles: ["notes.txt"], report: undefined, cost: 0, models: [], runId: "run_1" };

describe("PR body", () => {
  it("names the Flow, and a Studio Flow's version (go/no-go finding)", () => {
    expect(prBody({ ...base, flow: { name: "plan-and-pr", version: 3 } })).toContain("- Run: `run_1`\n- Flow: plan-and-pr v3 (Flow Studio)\n- Cost: $0.00");
    expect(prBody({ ...base, flow: { name: "fix-issue" } })).toContain("- Flow: fix-issue\n");
    expect(prBody(base)).not.toContain("- Flow:");
  });

  it("keeps a judge's reason inside its table cell, whatever backslashes and pipes it holds", () => {
    const competitors = [
      { key: "c1", agent: "claude-code", state: "finalist", reason: null, rank: 1, score: 8, judge_reason: "ends in a backslash \\ | and a pipe \\| then\nnew line" },
      { key: "c2", agent: "codex", state: "out", reason: "x", rank: null, score: null, judge_reason: null },
    ];
    const body = prBody({ ...base, compete: { winner: "c1", chosen_by: "judge", judge_summary: null, judge: undefined, competitors } });
    const row = body.split("\n").find((l) => l.startsWith("| c1"))!;
    // Every | the text brought is escaped, and a backslash it brought is escaped first, so it cannot cancel an escape.
    expect(row).toBe("| c1 ✅ | claude-code | #1, 8/10: ends in a backslash \\\\ \\| and a pipe \\\\\\| then new line |");
    expect(body.split("\n").filter((l) => l.startsWith("| c1"))).toHaveLength(1);
  });
});
