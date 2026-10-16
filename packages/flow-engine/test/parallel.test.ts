import { describe, expect, it } from "vitest";
import { checkFlow, next, parseFlow, progress, simulateFlow, type RunContext, type Step, type TaskState } from "../src/index.ts";

const header = "apiVersion: navarch/v1\nkind: Flow\nmetadata: { name: reviews }\n";

/** Two reviews at once (one of them two steps long), then a summary that reads both. */
const reviews = (join = "all", extra = "") =>
  parseFlow(`${header}nodes:
  - { id: plan, type: agent, profile: planner }
  - id: reviews
    type: parallel
    join: ${join}
    branches:
      security:
        - { id: threat, type: agent, profile: researcher }
        - { id: audit, type: agent, profile: reviewer, inputs: { threats: "\${{ nodes.threat.outputs.summary }}" } }
      standards:
        - { id: style, type: agent, profile: reviewer }
${extra}  - { id: report, type: agent, profile: planner, inputs: { reviews: "\${{ nodes.reviews.outputs.summary }}" } }
edges: ["plan -> reviews -> report"]
`);

const ctx = (tasks: TaskState[], skipped: string[] = []): RunContext => ({ params: {}, project: {}, tasks, skipped });
const ok = (node_id: string, summary = `${node_id} done`): TaskState => ({ node_id, iteration: 1, status: "succeeded", outputs: { summary } });
const running = (node_id: string): TaskState => ({ node_id, iteration: 1, status: "running", outputs: null });
const failed = (node_id: string): TaskState => ({ node_id, iteration: 1, status: "failed", outputs: null });
const started = (step: Step) => (step.kind === "start" ? [step.start.node.id, step.start.parallel] : step);

describe("parallel node (ADR 0036)", () => {
  it("starts every branch at once and runs each branch in order", () => {
    const flow = reviews();
    expect(started(next(flow, ctx([ok("plan")])))).toEqual(["threat", { node_id: "reviews", branch: "security" }]);
    // The first branch is busy: the next call starts the second instead of waiting.
    expect(started(next(flow, ctx([ok("plan"), running("threat")])))).toEqual(["style", { node_id: "reviews", branch: "standards" }]);
    expect(next(flow, ctx([ok("plan"), running("threat"), running("style")]))).toEqual({ kind: "wait" });
    const audit = next(flow, ctx([ok("plan"), ok("threat"), running("style")]));
    expect(started(audit)).toEqual(["audit", { node_id: "reviews", branch: "security" }]);
    // A branch node reads the earlier node of its own branch.
    expect(audit.kind === "start" && audit.start.inputs.threats).toBe("threat done");
  });

  it("goes on with every branch's summary once all of them succeeded", () => {
    const step = next(reviews(), ctx([ok("plan"), ok("threat"), ok("audit", "no injection found"), ok("style", "naming is consistent")]));
    expect(step.kind === "start" && step.start.node.id).toBe("report");
    expect(step.kind === "start" && step.start.inputs.reviews).toBe("### security\n\nno injection found\n\n### standards\n\nnaming is consistent");
  });

  it("join all: one failed branch cancels the others, then fails the node", () => {
    const flow = reviews();
    expect(next(flow, ctx([ok("plan"), failed("threat"), running("style")]))).toEqual({ kind: "cancel", nodeIds: ["style"], reason: "not needed: reviews can no longer join (all)" });
    const step = next(flow, ctx([ok("plan"), failed("threat"), { ...running("style"), status: "cancelled" }]));
    expect(step).toEqual({ kind: "fail", reason: "reviews: 0 of 2 branch(es) succeeded, all needs 2; security: threat failed; standards: style was cancelled" });
  });

  it("join any: the first branch to succeed wins and the others stop", () => {
    const flow = reviews("any");
    expect(next(flow, ctx([ok("plan"), running("threat"), ok("style", "fine")]))).toEqual({ kind: "cancel", nodeIds: ["threat"], reason: "not needed: reviews joined (any)" });
    const step = next(flow, ctx([ok("plan"), { ...running("threat"), status: "cancelled" }, ok("style", "fine")]));
    expect(step.kind === "start" && step.start.inputs.reviews).toBe("### standards\n\nfine");
    // A failed branch does not end an any-join while another can still succeed.
    expect(next(flow, ctx([ok("plan"), ok("threat"), running("audit"), failed("style")]))).toEqual({ kind: "wait" });
  });

  it("join quorum:N needs N branches, and fails as soon as N is out of reach", () => {
    const flow = parseFlow(`${header}nodes:
  - id: votes
    type: parallel
    join: quorum:2
    branches:
      a: [{ id: va, type: agent, profile: reviewer }]
      b: [{ id: vb, type: agent, profile: reviewer }]
      c: [{ id: vc, type: agent, profile: reviewer }]
edges: [votes]
`);
    expect(next(flow, ctx([ok("va"), failed("vb"), running("vc")]))).toEqual({ kind: "wait" });
    expect(next(flow, ctx([ok("va"), ok("vb"), running("vc")]))).toMatchObject({ kind: "cancel", nodeIds: ["vc"] });
    expect(next(flow, ctx([failed("va"), failed("vb"), running("vc")]))).toMatchObject({ kind: "cancel", nodeIds: ["vc"], reason: "not needed: votes can no longer join (quorum:2)" });
    expect(next(flow, ctx([ok("va"), ok("vb"), ok("vc")]))).toEqual({ kind: "done", prOpened: false });
  });

  it("skips a branch node whose when is false, and the whole node when its own is", () => {
    const flow = reviews("all", "");
    const skipping = parseFlow(`${header}params:
  deep: { type: bool, default: false }
nodes:
  - id: reviews
    type: parallel
    branches:
      a: [{ id: quick, type: agent, profile: reviewer }, { id: deep, type: agent, profile: reviewer, when: "\${{ params.deep }}" }]
      b: [{ id: other, type: agent, profile: reviewer }]
edges: [reviews]
`);
    expect(next(skipping, { ...ctx([ok("quick"), running("other")]), params: { deep: false } })).toEqual({ kind: "skip", nodeId: "deep", reason: "when params.deep is false" });
    expect(next(skipping, { ...ctx([ok("quick"), ok("other")], ["deep"]), params: { deep: false } })).toEqual({ kind: "done", prOpened: false });
    const gated = parseFlow(`${header}nodes:
  - id: reviews
    type: parallel
    when: "\${{ project.work_item }}"
    branches:
      a: [{ id: x, type: agent, profile: reviewer }]
      b: [{ id: y, type: agent, profile: reviewer }]
edges: [reviews]
`);
    expect(next(gated, { ...ctx([]), project: { work_item: false } })).toEqual({ kind: "skip", nodeId: "reviews", reason: "when project.work_item is false" });
    expect(flow.nodes.find((n) => n.id === "reviews")?.type).toBe("parallel");
  });

  it("counts as one step of progress, done when joined", () => {
    const flow = reviews();
    expect(progress(flow, ctx([ok("plan"), ok("threat"), running("style")]))).toEqual({ done: 1, total: 3 });
    expect(progress(flow, ctx([ok("plan"), ok("threat"), ok("audit"), ok("style")]))).toEqual({ done: 2, total: 3 });
  });

  it("simulates the branches starting together", () => {
    const result = simulateFlow(reviews(), { outcomes: { style: { fail: true } } });
    expect(result.steps.map((s) => (s.kind === "start" ? `${s.node}:${s.status}` : s.node))).toEqual(["plan:succeeded", "threat:succeeded", "style:failed"]);
    expect(result.end).toMatchObject({ kind: "fail" });
    const any = simulateFlow(reviews("any"), { outcomes: { style: { outputs: { summary: "fine" } } } });
    expect(any.steps.map((s) => (s.kind === "start" ? `${s.node}:${s.status}` : s.node))).toEqual(["plan:succeeded", "threat:succeeded", "style:succeeded", "report:succeeded"]);
    expect(any.end).toEqual({ kind: "done", pr_opened: false });
  });
});

describe("checking parallel nodes", () => {
  const problems = (yaml: string, editing?: string[]) => checkFlow(`${header}${yaml}`, editing ? { editing } : {}).problems.map((p) => p.message);
  const two = (a: string, b = "{ id: y, type: agent, profile: reviewer }") => `nodes:
  - id: reviews
    type: parallel
    branches:
      a: [${a}]
      b: [${b}]
  - { id: after, type: agent, profile: planner, inputs: { x: "\${{ nodes.x.outputs.summary }}" } }
edges: ["reviews -> after"]
`;

  it("accepts a valid node, and later nodes read branch nodes", () => {
    expect(problems(two("{ id: x, type: agent, profile: reviewer }"), ["implementer"])).toEqual([]);
  });

  it("refuses editing agents in branches", () => {
    expect(problems(two("{ id: x, type: agent, profile: implementer }"), ["implementer"])).toEqual([
      'node "x": profile "implementer" edits the worktree, and parallel branches run read-only agents; edit in parallel with a team or compete node',
    ]);
  });

  it("refuses a branch node that reads another branch", () => {
    expect(problems(two("{ id: x, type: agent, profile: reviewer }", '{ id: y, type: agent, profile: reviewer, inputs: { z: "${{ nodes.x.outputs.summary }}" } }'))).toEqual(['node "y" reads "x", which runs later']);
  });

  it("refuses a quorum larger than the branches, one branch, and a duplicate id", () => {
    expect(problems(two("{ id: x, type: agent, profile: reviewer }").replace("type: parallel", "type: parallel\n    join: quorum:3"))).toEqual(['node "reviews": join quorum:3 needs more branches than its 2']);
    expect(problems(`nodes:\n  - id: p\n    type: parallel\n    branches:\n      a: [{ id: x, type: agent, profile: reviewer }]\nedges: [p]\n`)).toEqual(["nodes.0.branches: a parallel node has 2 to 8 branches"]);
    expect(problems(two("{ id: y, type: agent, profile: reviewer }").replace("nodes.x", "nodes.y"))).toContain('duplicate node id "y"');
  });
});
