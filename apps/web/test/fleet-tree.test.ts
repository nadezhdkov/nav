import type { FleetAgent, FleetRun, FleetView, TeamView } from "@navarch/contracts";
import { describe, expect, it } from "vitest";
import { agentNodeId, buildFleetTree, moveFocus, OTHER_REPOS, runNodeId, subagentsNodeId } from "../src/lib/fleetTree.ts";

function agent(over: Partial<FleetAgent> = {}): FleetAgent {
  return {
    id: "task_impl", run_id: "run_1", node_id: "implement", type: "agent", status: "running", attempt: 1, max_attempts: 3,
    profile: "implementer", adapter: "claude-code", model: null, sandbox_path: null, branch: null, cost: 0, plan_cost: 0, summary: null, error: null,
    not_before: null, updated_at: "2026-10-15T01:00:00Z", iteration: 1, last_activity: null, waiting: null, resumable: true,
    pending_messages: 0, team_role: null, team_key: null, ...over,
  };
}

function run(over: Partial<FleetRun> = {}): FleetRun {
  return {
    id: "run_1", name: "brave-frigate", status: "executing", repo_path: "/src/app", base_commit: "abc", prompt: "p", budget: 2, cost_total: 0, plan_cost: 0,
    created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z", ended_at: null, work_item: null, pr_url: null,
    flow: "task", autonomy_level: 2, team: null, progress: { done: 0, total: 2 }, project_id: null, agents: [], ...over,
  };
}

const view = (runs: FleetRun[]): FleetView => ({ generated_at: "2026-10-15T01:00:00Z", counts: { running: 0, waiting: 0, failed: 0, done: 0 }, runs });
const projects = [{ id: "prj_app", name: "app", repo: "o/app", path: "/src/app/" }];

describe("Fleet tree (slice 10)", () => {
  it("puts runs under their project, the rest under Other repositories grouped by path, agents in Flow order", () => {
    const tree = buildFleetTree(
      view([
        run({ id: "run_1", project_id: "prj_app", agents: [agent({ node_id: "plan", status: "succeeded" }), agent()] }),
        run({ id: "run_2", repo_path: "/z/zed", created_at: "2026-10-15T00:00:02Z" }),
        run({ id: "run_3", repo_path: "/a/alpha" }),
        run({ id: "run_4", repo_path: "/src/app" }),
      ]),
      projects,
    );
    const byId = new Map(tree.nodes.map((n) => [n.id, n]));
    expect(tree.nodes.filter((n) => !n.parent).map((n) => n.id)).toEqual(["project:prj_app", OTHER_REPOS]);
    // A run without project_id still lands in its project when the path matches.
    expect(byId.get("project:prj_app")!.children).toEqual([runNodeId("run_1"), runNodeId("run_4")]);
    expect(byId.get("project:prj_app")).toMatchObject({ project: { name: "app", runs: 2, running: 1 } });
    expect(byId.get(OTHER_REPOS)!.children).toEqual([runNodeId("run_3"), runNodeId("run_2")]);
    expect(byId.get(runNodeId("run_1"))!.children).toEqual([agentNodeId("run_1", "plan"), agentNodeId("run_1", "implement")]);
    expect(tree.edges).toContainEqual(expect.objectContaining({ source: runNodeId("run_1"), target: agentNodeId("run_1", "implement"), kind: "tree", animated: true }));
    // Parents sit above their children, siblings do not overlap.
    const [a, b] = [byId.get(agentNodeId("run_1", "plan"))!, byId.get(agentNodeId("run_1", "implement"))!];
    expect(a.position.y).toBeGreaterThan(byId.get(runNodeId("run_1"))!.position.y);
    expect(a.position.x + a.width).toBeLessThan(b.position.x);
  });

  it("folds a run into its agent count and worst state", () => {
    const r = run({ agents: [agent({ status: "succeeded" }), agent({ node_id: "review", status: "waiting_approval" })] });
    const tree = buildFleetTree(view([r]), [], new Set([runNodeId("run_1")]));
    const node = tree.nodes.find((n) => n.id === runNodeId("run_1"))!;
    expect(node).toMatchObject({ kind: "run", collapsed: true, agentCount: 2, worst: "waiting_approval", children: [] });
    expect(tree.nodes.some((n) => n.kind === "agent")).toBe(false);
  });

  it("draws a team: lead, members it delegated with their turn, dependencies, reports and folded sub-agents", () => {
    const team: TeamView = {
      node_id: "team", turn: 2, max_turns: 8, lead_task_id: "task_lead", question: null, summary: "split", plan_errors: [],
      members: [
        { key: "api", title: "API", profile: "implementer", prefer: "codex", depends_on: [], turn: 1, task_id: "task_api", status: "succeeded", summary: "done" },
        { key: "ui", title: "UI", profile: "implementer", prefer: null, depends_on: ["api"], turn: 2, task_id: "task_ui", status: "running", summary: null },
        { key: "docs", title: "Docs", profile: "planner", prefer: null, depends_on: ["ui"], turn: 2, task_id: null, status: "planned", summary: null },
      ],
      subagents: [{ task_id: "task_lead", tool_use_id: "tu_1", description: "search", status: "finished" }],
    };
    const r = run({
      flow: "team",
      team,
      agents: [
        agent({ id: "task_lead", node_id: "team.lead", profile: "lead", team_role: "lead", status: "succeeded" }),
        agent({ id: "task_api", node_id: "team.api", team_role: "member", team_key: "api", status: "succeeded" }),
        agent({ id: "task_ui", node_id: "team.ui", team_role: "member", team_key: "ui", status: "running" }),
      ],
    });
    const lead = agentNodeId("run_1", "team.lead");
    const tree = buildFleetTree(view([r]), []);
    const byId = new Map(tree.nodes.map((n) => [n.id, n]));
    expect(byId.get(runNodeId("run_1"))!.children).toEqual([lead]);
    expect(byId.get(lead)).toMatchObject({ kind: "agent", role: "lead" });
    expect(byId.get(lead)!.children).toEqual([agentNodeId("run_1", "team.api"), agentNodeId("run_1", "team.ui"), agentNodeId("run_1", "team.docs"), subagentsNodeId("run_1")]);
    expect(byId.get(agentNodeId("run_1", "team.docs"))).toMatchObject({ agent: null, member: { status: "planned" } });
    const kinds = tree.edges.map((e) => `${e.kind}:${e.source.split(":").pop()}->${e.target.split(":").pop()}${e.turn ? `@${e.turn}` : ""}${e.animated ? "~" : ""}`);
    expect(kinds).toEqual(expect.arrayContaining(["delegates:team.lead->team.api@1", "delegates:team.lead->team.ui@2~", "reports:team.api->team.lead", "after:team.api->team.ui", "after:team.ui->team.docs"]));
    expect(kinds).not.toContain("reports:team.ui->team.lead");
    expect(tree.nodes.some((n) => n.kind === "subagent")).toBe(false);
    expect(buildFleetTree(view([r]), [], new Set(), new Set([subagentsNodeId("run_1")])).nodes.filter((n) => n.kind === "subagent")).toHaveLength(1);
  });

  it("moves focus along the tree with the arrow keys", () => {
    const tree = buildFleetTree(view([run({ agents: [agent({ node_id: "plan" }), agent()] }), run({ id: "run_2" })]), []);
    const r1 = runNodeId("run_1");
    expect(moveFocus(tree.nodes, null, "down")).toBe(OTHER_REPOS);
    expect(moveFocus(tree.nodes, OTHER_REPOS, "down")).toBe(r1);
    expect(moveFocus(tree.nodes, r1, "right")).toBe(runNodeId("run_2"));
    expect(moveFocus(tree.nodes, r1, "left")).toBe(r1);
    expect(moveFocus(tree.nodes, r1, "down")).toBe(agentNodeId("run_1", "plan"));
    expect(moveFocus(tree.nodes, agentNodeId("run_1", "plan"), "right")).toBe(agentNodeId("run_1", "implement"));
    expect(moveFocus(tree.nodes, agentNodeId("run_1", "implement"), "up")).toBe(r1);
    expect(moveFocus(tree.nodes, OTHER_REPOS, "up")).toBe(OTHER_REPOS);
  });
});
