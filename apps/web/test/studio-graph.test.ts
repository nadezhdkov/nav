import { describe, expect, it } from "vitest";
import { readDraft } from "../src/lib/flowDoc.ts";
import { buildStudioGraph, walkOrder } from "../src/lib/studioGraph.ts";

const yaml = `apiVersion: navarch/v1
kind: Flow
metadata: { name: t }
nodes:
  - { id: plan, type: agent, profile: planner }
  - id: fix
    type: loop
    max_iterations: 3
    until: \${{ nodes.verify.outputs.passed }}
    body:
      - { id: implement, type: agent, profile: implementer }
      - { id: verify, type: action, uses: verification.run }
  - { id: orphan, type: approval }
edges:
  - plan -> fix
`;

describe("Flow Studio canvas", () => {
  const view = readDraft(yaml)!;

  it("lays out the chain, loop lanes and disconnected nodes in a row of their own", () => {
    const { nodes, edges } = buildStudioGraph(view);
    expect(nodes.map((n) => [n.id, n.connected, n.parent])).toEqual([
      ["plan", true, null],
      ["fix", true, null],
      ["implement", true, "fix"],
      ["verify", true, "fix"],
      ["orphan", false, null],
    ]);
    const orphan = nodes.find((n) => n.id === "orphan")!;
    expect(orphan.position.y).toBeGreaterThan(nodes.find((n) => n.id === "plan")!.position.y);
    expect(nodes.find((n) => n.id === "fix")!.detail).toBe("≤ 3");
    expect(edges.map((e) => e.id)).toEqual(["implement->verify", "verify->implement:back", "plan->fix"]);
  });

  it("counts problems per node and lights the simulated path", () => {
    const { nodes, edges } = buildStudioGraph(
      view,
      [
        { severity: "error", message: "x", node: "orphan" },
        { severity: "warning", message: "y", node: "orphan" },
      ],
      {
        problems: [],
        steps: [
          { kind: "start", node: "plan", type: "agent", iteration: 1, stage: "planning", status: "succeeded", outputs: {} },
          { kind: "start", node: "implement", type: "agent", iteration: 1, stage: "executing", status: "succeeded", outputs: {} },
          { kind: "start", node: "verify", type: "action", iteration: 1, stage: "verifying", status: "succeeded", outputs: {} },
          { kind: "start", node: "implement", type: "agent", iteration: 2, stage: "executing", status: "succeeded", outputs: {} },
        ],
        end: { kind: "done", pr_opened: false },
      },
    );
    expect(nodes.find((n) => n.id === "orphan")).toMatchObject({ errors: 1, warnings: 1 });
    expect(nodes.find((n) => n.id === "implement")).toMatchObject({ sim: "succeeded", runs: 2 });
    expect(nodes.find((n) => n.id === "fix")!.sim).toBe("succeeded");
    expect(edges.find((e) => e.id === "plan->fix")!.simulated).toBe(true);
  });

  it("walks nodes in chain order, bodies after their loop, then the disconnected ones", () => {
    expect(walkOrder(view)).toEqual(["plan", "fix", "implement", "verify", "orphan"]);
  });
});
