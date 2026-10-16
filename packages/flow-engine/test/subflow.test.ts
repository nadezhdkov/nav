import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FlowDefinition } from "@navarch/contracts";
import { describe, expect, it } from "vitest";
import { FlowError, next, parseFlow, progress, resolveParams, subflowsOf, type RunContext, type TaskState } from "../src/index.ts";

const builtin = (name: string) => parseFlow(readFileSync(fileURLToPath(new URL(`../../../flows/${name}.yaml`, import.meta.url)), "utf8"));

const flow = (name: string, body: string) => parseFlow(`apiVersion: navarch/v1\nkind: Flow\nmetadata: { name: ${name} }\n${body}`);

const child = flow(
  "child",
  `params:
  tries: { type: int, default: 3 }
nodes:
  - id: loop
    type: loop
    max_iterations: \${{ params.tries }}
    until: \${{ nodes.check.outputs.passed }}
    body:
      - { id: work, type: agent, profile: implementer, inputs: { failures: "\${{ nodes.check.outputs.blocking_failures }}" } }
      - { id: check, type: action, uses: verification.run }
edges: [loop]
`,
);

const parent = flow(
  "parent",
  `params:
  tries: { type: int, default: 2 }
nodes:
  - { id: diagnose, type: agent, profile: triager }
  - id: fix
    type: subflow
    flow: child
    when: \${{ nodes.diagnose.outputs.kind == 'code' }}
    with: { tries: "\${{ params.tries }}" }
    inputs: { diagnosis: "\${{ nodes.diagnose.outputs.summary }}", task: Fix the build }
  - { id: review, type: agent, profile: reviewer, inputs: { implementation: "\${{ nodes.fix.outputs.summary }}" } }
edges: ["diagnose -> fix -> review"]
`,
);

const flows = new Map<string, FlowDefinition>([
  ["child", child],
  ["parent", parent],
]);

/** Runs `parent` to the end, finishing each started task with `finish`. */
function drive(finish: (node: string, iteration: number, inputs: Record<string, unknown>) => Partial<TaskState>) {
  const ctx: RunContext = { params: resolveParams(parent), project: {}, tasks: [], skipped: [], subflows: subflowsOf(parent, flows) };
  const trace: string[] = [];
  const inputs: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < 50; i++) {
    const step = next(parent, ctx);
    if (step.kind === "start") {
      const { node, iteration } = step.start;
      trace.push(`${node.id}#${iteration}`);
      inputs[`${node.id}#${iteration}`] = step.start.inputs;
      ctx.tasks.push({ node_id: node.id, iteration, status: "succeeded", outputs: {}, ...finish(node.id, iteration, step.start.inputs) });
    } else if (step.kind === "skip") {
      trace.push(`skip ${step.nodeId}`);
      ctx.skipped.push(step.nodeId);
    } else {
      return { trace, end: step, inputs, ctx };
    }
  }
  throw new Error("flow did not end");
}

describe("subflow", () => {
  it("runs the child's nodes as prefixed tasks, with its params from `with` and the node's inputs on its agents", () => {
    const { trace, end, inputs } = drive((node, iteration) => {
      if (node === "diagnose") return { outputs: { summary: "lint fails", kind: "code" } };
      if (node === "fix.check") return { outputs: { passed: iteration >= 2, blocking_failures: iteration >= 2 ? [] : ["lint"] } };
      return { outputs: { summary: `${node} ${iteration}` } };
    });
    expect(trace).toEqual(["diagnose#1", "fix.work#1", "fix.check#1", "fix.work#2", "fix.check#2", "review#1"]);
    expect(end).toEqual({ kind: "done", prOpened: false });
    expect(inputs["fix.work#1"]).toEqual({ diagnosis: "lint fails", task: "Fix the build", failures: undefined });
    // Child expressions see the child's own tasks.
    expect(inputs["fix.work#2"]).toMatchObject({ diagnosis: "lint fails", failures: ["lint"] });
    // The node's outputs are its child's last succeeded agent task's.
    expect(inputs["review#1"]).toEqual({ implementation: "fix.work 2" });
  });

  it("fails the parent when the child fails, with the reason prefixed", () => {
    const { trace, end } = drive((node) => {
      if (node === "diagnose") return { outputs: { kind: "code" } };
      if (node === "fix.check") return { outputs: { passed: false, blocking_failures: ["lint"] } };
      return {};
    });
    // `with: { tries: params.tries }` gave the child 2 iterations, not its default 3.
    expect(trace).toEqual(["diagnose#1", "fix.work#1", "fix.check#1", "fix.work#2", "fix.check#2"]);
    expect(end).toEqual({ kind: "fail", reason: expect.stringMatching(/^subflow fix: loop stopped after 2 iteration/) });
  });

  it("skips the whole node when its `when` is false, and counts it as one step", () => {
    const { trace, end, ctx } = drive((node) => (node === "diagnose" ? { outputs: { kind: "flaky" } } : {}));
    expect(trace).toEqual(["diagnose#1", "skip fix", "review#1"]);
    expect(end.kind).toBe("done");
    expect(progress(parent, ctx)).toEqual({ done: 3, total: 3 });
  });

  it("records the child's skipped nodes with the prefix", () => {
    const gated = flow("gated", `nodes:\n  - { id: maybe, type: agent, profile: planner, when: "\${{ project.autonomy_level < 3 }}" }\n  - { id: after, type: agent, profile: planner }\nedges: ["maybe -> after"]\n`);
    const host = flow("host", `nodes:\n  - { id: sub, type: subflow, flow: gated }\nedges: [sub]\n`);
    const ctx: RunContext = { params: {}, project: { autonomy_level: 3 }, tasks: [], skipped: [], subflows: subflowsOf(host, new Map([["gated", gated]])) };
    expect(next(host, ctx)).toEqual({ kind: "skip", nodeId: "sub.maybe", reason: expect.any(String) });
    ctx.skipped.push("sub.maybe");
    const step = next(host, ctx);
    expect(step.kind === "start" && step.start.node.id).toBe("sub.after");
  });

  it("refuses unknown flows, unknown params and composite nodes in the child", () => {
    const host = (body: string) => flow("host", `nodes:\n  - ${body}\nedges: [sub]\n`);
    const team = builtin("team");
    const known = new Map<string, FlowDefinition>([["child", child], ["team", team], ["parent", parent]]);
    expect(() => subflowsOf(host("{ id: sub, type: subflow, flow: nope }"), known)).toThrow(/unknown flow "nope"/);
    expect(() => subflowsOf(host("{ id: sub, type: subflow, flow: child, with: { typo: 1 } }"), known)).toThrow(/has no param "typo"/);
    expect(() => subflowsOf(host("{ id: sub, type: subflow, flow: team }"), known)).toThrow(FlowError);
    expect(() => subflowsOf(host("{ id: sub, type: subflow, flow: parent }"), known)).toThrow(/cannot hold.*subflow/);
  });

  it("checks the expressions of `with` and `inputs` against the parent", () => {
    expect(() => flow("bad", `nodes:\n  - { id: sub, type: subflow, flow: child, inputs: { a: "\${{ nodes.zz.outputs.summary }}" } }\nedges: [sub]\n`)).toThrow(/unknown node "zz"/);
    expect(() => flow("bad", `nodes:\n  - { id: sub, type: subflow, flow: child, with: { tries: "\${{ params.nope }}" } }\nedges: [sub]\n`)).toThrow(/unknown param "nope"/);
  });

  it("loads ci-fix, whose fix runs the task flow", () => {
    const ciFix = builtin("ci-fix");
    expect(Object.keys(subflowsOf(ciFix, new Map([["task", builtin("task")]])))).toEqual(["task"]);
    expect(builtin("review-pr").metadata.name).toBe("review-pr");
  });
});
