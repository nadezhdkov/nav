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
});
