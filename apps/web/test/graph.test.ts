import type { FlowDefinition, TaskView } from "@navarch/contracts";
import { describe, expect, it } from "vitest";
import { buildGraph, ROW_WIDTH } from "../src/lib/graph.ts";

const flow: FlowDefinition = {
  apiVersion: "navarch/v1",
  kind: "Flow",
  metadata: { name: "fix-issue" },
  params: {},
  nodes: [
    { id: "start", type: "trigger" },
    { id: "plan", type: "agent", profile: "planner" },
    { id: "approve_plan", type: "approval" },
    {
      id: "implement_loop",
      type: "loop",
      max_iterations: 3,
      until: "${{ nodes.verify.outputs.passed }}",
      body: [
        { id: "implement", type: "agent", profile: "implementer" },
        { id: "verify", type: "action", uses: "verification.run" },
      ],
    },
    { id: "open_pr", type: "github", uses: "pr.create" },
  ],
  edges: ["start -> plan -> approve_plan", "approve_plan -> implement_loop -> open_pr"],
};

function task(node_id: string, status: TaskView["status"], extra: Partial<TaskView> = {}): TaskView {
  return {
    id: `task_${node_id}_${extra.iteration ?? 1}`,
    run_id: "run_1",
    node_id,
    type: "agent",
    status,
    attempt: 1,
    max_attempts: 3,
    profile: "implementer",
    adapter: "claude-code",
    model: null,
    sandbox_path: null,
    branch: null,
    cost: 0,
    summary: null,
    error: null,
    not_before: null,
    updated_at: "2026-10-15T00:00:00Z",
    iteration: 1,
    ...extra,
  };
}

describe("buildGraph", () => {
  it("lays the top-level chain out in reading order and links it in edge order", () => {
    const g = buildGraph(flow, [], []);
    const top = g.nodes.filter((n) => !n.parent).map((n) => n.id);
    expect(top).toEqual(["start", "plan", "approve_plan", "implement_loop", "open_pr"]);
    const placed = g.nodes.filter((n) => !n.parent);
    const reading = [...placed].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x).map((n) => n.id);
    expect(reading).toEqual(top);
    const topEdges = g.edges.filter((e) => top.includes(e.source) && top.includes(e.target));
    expect(topEdges.map((e) => `${e.source}>${e.target}`)).toEqual([
      "start>plan",
      "plan>approve_plan",
      "approve_plan>implement_loop",
      "implement_loop>open_pr",
    ]);
  });

  it("wraps a long chain into rows and marks the edge between rows", () => {
    const long: FlowDefinition = {
      ...flow,
      nodes: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, type: "agent" as const, profile: "implementer" })),
      edges: ["a -> b -> c -> d -> e -> f"],
    };
    const g = buildGraph(long, [], []);
    const ys = [...new Set(g.nodes.map((n) => n.position.y))];
    expect(ys.length).toBeGreaterThan(1);
    expect(Math.max(...g.nodes.map((n) => n.position.x + n.width))).toBeLessThanOrEqual(ROW_WIDTH);
    const wraps = g.edges.filter((e) => e.wrap);
    expect(wraps).toHaveLength(ys.length - 1);
    expect(g.nodes.find((n) => n.id === wraps[0]!.target)?.position.x).toBe(0);
  });

  it("puts loop bodies inside their loop with a dashed edge back to the first body node", () => {
    const g = buildGraph(flow, [], []);
    const body = g.nodes.filter((n) => n.parent === "implement_loop").map((n) => n.id);
    expect(body).toEqual(["implement", "verify"]);
    expect(g.edges).toContainEqual(expect.objectContaining({ source: "implement", target: "verify", kind: "flow" }));
    expect(g.edges).toContainEqual(expect.objectContaining({ source: "verify", target: "implement", kind: "loop-back" }));
  });

  it("shows each node's latest task and counts loop iterations", () => {
    const tasks = [
      task("plan", "succeeded", { profile: "planner", model: "claude-sonnet" }),
      task("implement", "succeeded", { iteration: 1 }),
      task("verify", "failed", { iteration: 1, type: "action" }),
      task("implement", "running", { iteration: 2 }),
    ];
    const g = buildGraph(flow, tasks, []);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get("plan")?.state).toBe("succeeded");
    expect(byId.get("plan")?.task?.model).toBe("claude-sonnet");
    expect(byId.get("implement")?.state).toBe("running");
    expect(byId.get("implement")?.task?.iteration).toBe(2);
    expect(byId.get("implement")?.tasks).toHaveLength(2);
    expect(byId.get("implement_loop")?.state).toBe("running");
    expect(byId.get("implement_loop")?.iteration).toBe(2);
    expect(byId.get("open_pr")?.state).toBe("not_started");
  });

  it("marks the trigger done once any task exists, skipped nodes as skipped, and gates as waiting", () => {
    const g = buildGraph(flow, [task("plan", "succeeded"), task("approve_plan", "waiting_approval", { type: "approval" })], [
      "open_pr",
    ]);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get("start")?.state).toBe("succeeded");
    expect(byId.get("approve_plan")?.state).toBe("waiting_approval");
    expect(byId.get("open_pr")?.state).toBe("skipped");
  });

  it("shows a loop's max iterations from the run's params, else the Flow default", () => {
    const withParam: FlowDefinition = {
      ...flow,
      params: { max_fix_iterations: { type: "int", default: 3 } },
      nodes: flow.nodes.map((n) => (n.type === "loop" ? { ...n, max_iterations: "${{ params.max_fix_iterations }}" } : n)),
    };
    const loop = (params?: Record<string, number>) => buildGraph(withParam, [], [], params).nodes.find((n) => n.id === "implement_loop");
    expect(loop()?.maxIterations).toBe(3);
    expect(loop({ max_fix_iterations: 5 })?.maxIterations).toBe(5);
  });

  it("derives a finished loop from its last iteration", () => {
    const g = buildGraph(flow, [task("implement", "succeeded"), task("verify", "succeeded")], []);
    expect(g.nodes.find((n) => n.id === "implement_loop")?.state).toBe("succeeded");
  });
});
