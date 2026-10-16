import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFlow, simulateFlow } from "../src/index.ts";

const builtin = (name: string) => parseFlow(readFileSync(fileURLToPath(new URL(`../../../flows/${name}.yaml`, import.meta.url)), "utf8"));
const trace = (r: ReturnType<typeof simulateFlow>) => r.steps.map((s) => (s.kind === "skip" ? `skip ${s.node}` : `${s.node}#${s.iteration}${s.status === "failed" ? "!" : ""}`));

describe("simulateFlow", () => {
  const fixIssue = builtin("fix-issue");

  it("walks fix-issue with every node succeeding", () => {
    const r = simulateFlow(fixIssue);
    expect(trace(r)).toEqual(["triage#1", "plan#1", "approve_plan#1", "implement#1", "verify#1", "review#1", "open_pr#1"]);
    expect(r.end).toEqual({ kind: "done", pr_opened: true });
    expect(r.steps[0]).toMatchObject({ type: "agent", stage: "planning", outputs: { summary: "(simulated)" } });
  });

  it("repeats the fix loop while verify fails, with per-iteration outputs", () => {
    const r = simulateFlow(fixIssue, { outcomes: { verify: { outputs: [{ passed: false }, { passed: false }, { passed: true }] } } });
    expect(trace(r).slice(3)).toEqual(["implement#1", "verify#1", "implement#2", "verify#2", "implement#3", "verify#3", "review#1", "open_pr#1"]);
    expect(r.end?.kind).toBe("done");
  });

  it("fails when the loop runs out, and skips nodes whose when is false", () => {
    const r = simulateFlow(fixIssue, { autonomy_level: 3, outcomes: { verify: { outputs: { passed: false } } } });
    expect(trace(r)).toContain("skip approve_plan");
    expect(r.end).toEqual({ kind: "fail", reason: expect.stringMatching(/implement_loop stopped after 3 iteration/) });
  });

  it("fails a node marked to fail, and an approval marked rejected", () => {
    expect(simulateFlow(fixIssue, { outcomes: { review: { fail: true } } }).end).toEqual({ kind: "fail", reason: "node review failed" });
    const rejected = simulateFlow(fixIssue, { outcomes: { approve_plan: { fail: true } } });
    expect(trace(rejected).at(-1)).toBe("approve_plan#1!");
    expect(rejected.end?.kind).toBe("fail");
  });

  it("uses the params given over the defaults", () => {
    const r = simulateFlow(fixIssue, { params: { max_fix_iterations: 1 }, outcomes: { verify: { outputs: { passed: false } } } });
    expect(r.end).toEqual({ kind: "fail", reason: expect.stringMatching(/after 1 iteration/) });
  });

  it("runs team and compete nodes as one step", () => {
    expect(trace(simulateFlow(builtin("team")))[0]).toBe("team#1");
    const compete = simulateFlow(builtin("compete"));
    expect(compete.steps[0]).toMatchObject({ node: "compete", type: "compete", outputs: { summary: "(simulated)" } });
    expect(compete.end?.kind).toBe("done");
  });

  it("walks a subflow's child steps under the node's id", () => {
    const flows = { task: builtin("task") };
    const r = simulateFlow(builtin("ci-fix"), { subflows: flows, outcomes: { diagnose: { outputs: { kind: "code" } } } });
    expect(trace(r)).toEqual(expect.arrayContaining(["diagnose#1", "fix.implement#1", "fix.verify#1", "open_pr#1", "skip comment"]));
    const flaky = simulateFlow(builtin("ci-fix"), { subflows: flows, outcomes: { diagnose: { outputs: { kind: "flaky" } } } });
    expect(trace(flaky)).toEqual(expect.arrayContaining(["skip fix", "comment#1"]));
  });

  it("stops at the step limit", () => {
    const r = simulateFlow(fixIssue, { params: { max_fix_iterations: 1000 }, outcomes: { verify: { outputs: { passed: false } } }, maxSteps: 20 });
    expect(r.steps).toHaveLength(20);
    expect(r.end).toEqual({ kind: "limit" });
  });
});
