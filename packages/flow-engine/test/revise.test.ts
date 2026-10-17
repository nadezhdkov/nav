import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { next, parseFlow, resolveParams, type RunContext, type TaskState } from "../src/index.ts";

const fixIssue = readFileSync(fileURLToPath(new URL("../../../flows/fix-issue.yaml", import.meta.url)), "utf8");

/** Runs fix-issue to the end; `approval(n)` says what the nth approval of the plan answered. */
function drive(approval: (iteration: number) => Partial<TaskState>) {
  const flow = parseFlow(fixIssue);
  const ctx: RunContext = { params: resolveParams(flow), project: { autonomy_level: 2 }, tasks: [], skipped: [] };
  const trace: string[] = [];
  const starts: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < 60; i++) {
    const step = next(flow, ctx);
    if (step.kind === "start") {
      const { node, iteration } = step.start;
      trace.push(`${node.id}#${iteration}`);
      starts[`${node.id}#${iteration}`] = step.start.inputs;
      const done: Partial<TaskState> =
        node.id === "approve_plan" ? approval(iteration) : node.id === "verify" ? { outputs: { passed: true } } : { outputs: { summary: `${node.id} v${iteration}` } };
      ctx.tasks.push({ node_id: node.id, iteration, status: "succeeded", outputs: {}, ...done });
    } else if (step.kind === "skip") {
      ctx.skipped.push(step.nodeId);
    } else {
      return { trace, end: step, starts };
    }
  }
  throw new Error("flow did not end");
}

describe("an approval the approver sent back (ADR 0039)", () => {
  it("runs the planner again with the feedback, then asks for approval of the new plan", () => {
    const { trace, end, starts } = drive((n) => (n === 1 ? { outputs: { approved: false, revise: true, feedback: "name the files" } } : { outputs: { approved: true } }));
    expect(trace.slice(0, 5)).toEqual(["triage#1", "plan#1", "approve_plan#1", "plan#2", "approve_plan#2"]);
    expect(trace).toContain("implement#1");
    expect(starts["plan#2"]).toMatchObject({ revision_feedback: "name the files", previous_plan: "plan v1" });
    expect(end).toEqual({ kind: "done", prOpened: true });
  });

  it("does not use the first plan once a better one exists", () => {
    const { starts } = drive((n) => (n === 1 ? { outputs: { revise: true, feedback: "split it" } } : { outputs: { approved: true } }));
    expect(starts["implement#1"]).toMatchObject({ plan: "plan v2" });
  });

  it("fails when the plan keeps being sent back", () => {
    const { end } = drive(() => ({ outputs: { revise: true, feedback: "again" } }));
    expect(end).toMatchObject({ kind: "fail", reason: expect.stringContaining("sent back") });
  });

  it("leaves a plain approval alone", () => {
    const { trace } = drive(() => ({ outputs: { approved: true } }));
    expect(trace.filter((t) => t.startsWith("plan"))).toEqual(["plan#1"]);
  });
});
