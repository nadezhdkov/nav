import type { FleetAgent, FleetRun, FleetView, ProjectView, TeamMemberView, TeamView } from "@navarch/contracts";
import type { InjectionKey, Ref } from "vue";
import type { NodeState } from "./graph.ts";

/**
 * The Fleet as a tree (slice 10): project → run → agents, and in a team run lead → members →
 * the lead's internal sub-agents. Grouping and layout only; every state comes from `FleetView`.
 */

export type TreeNodeKind = "project" | "run" | "agent" | "group" | "subagents" | "subagent";

type Base = { id: string; parent: string | null; children: string[]; position: { x: number; y: number }; width: number; height: number };

export type TreeNode =
  | (Base & { kind: "project"; project: { id: string | null; name: string; repo: string | null; runs: number; running: number } })
  | (Base & { kind: "run"; run: FleetRun; collapsed: boolean; agentCount: number; worst: NodeState | null })
  | (Base & {
      kind: "agent";
      run: FleetRun;
      /** Null for a team member the lead planned that has not started. */
      agent: FleetAgent | null;
      role: "lead" | "member" | null;
      member: TeamMemberView | null;
      team: TeamView | null;
      /** The member key whose merge conflict this agent resolves, in a parallel team (ADR 0029). */
      resolves?: string;
    })
  /** A heading over the members the lead put in one group (ADR 0051); presentation only. */
  | (Base & { kind: "group"; run: FleetRun; name: string; members: TeamMemberView[]; worst: NodeState | null })
  | (Base & { kind: "subagents"; run: FleetRun; count: number; expanded: boolean })
  | (Base & { kind: "subagent"; run: FleetRun; subagent: TeamView["subagents"][number] });

export type TreeEdgeKind = "tree" | "delegates" | "after" | "reports";
export type TreeEdge = { id: string; source: string; target: string; kind: TreeEdgeKind; turn?: number; animated: boolean };

export const OTHER_REPOS = "project:other";

export const SIZE: Record<TreeNodeKind | "lead", { width: number; height: number }> = {
  project: { width: 260, height: 76 },
  run: { width: 300, height: 128 },
  agent: { width: 264, height: 196 },
  lead: { width: 320, height: 236 },
  group: { width: 220, height: 56 },
  subagents: { width: 220, height: 40 },
  subagent: { width: 220, height: 60 },
};
const H_GAP = 32;
const V_GAP = 72;

/** Worst first: a collapsed run shows the state that most needs attention. */
const SEVERITY: NodeState[] = ["failed", "blocked", "waiting_approval", "interrupted", "paused", "running", "ready", "pending", "succeeded", "cancelled", "skipped", "not_started"];

export const runNodeId = (runId: string) => `run:${runId}`;
export const agentNodeId = (runId: string, nodeId: string) => `agent:${runId}:${nodeId}`;
export const groupNodeId = (runId: string, name: string) => `group:${runId}:${name}`;
export const subagentsNodeId = (runId: string) => `subagents:${runId}`;

const trim = (path: string) => path.replace(/\/+$/, "");

/**
 * Builds the tree. `collapsed` holds run node ids folded by the user; `expanded` holds the
 * sub-agent groups opened by the user (folded by default).
 */
export function buildFleetTree(
  view: FleetView,
  projects: readonly Pick<ProjectView, "id" | "name" | "repo" | "path">[],
  collapsed: ReadonlySet<string> = new Set(),
  expanded: ReadonlySet<string> = new Set(),
): { nodes: TreeNode[]; edges: TreeEdge[] } {
  const nodes = new Map<string, TreeNode>();
  const edges: TreeEdge[] = [];
  const roots: string[] = [];
  const add = <T extends TreeNode>(node: T): T => {
    nodes.set(node.id, node);
    if (node.parent) nodes.get(node.parent)!.children.push(node.id);
    else roots.push(node.id);
    return node;
  };
  const base = (id: string, parent: string | null, size: { width: number; height: number }): Base => ({ id, parent, children: [], position: { x: 0, y: 0 }, ...size });
  const link = (source: string, target: string, kind: TreeEdgeKind, animated: boolean, turn?: number) =>
    edges.push({ id: `${kind}:${source}->${target}`, source, target, kind, animated, ...(turn !== undefined ? { turn } : {}) });

  // Projects that have runs in view, in their registered order; then the other repositories.
  const byProject = new Map<string, FleetRun[]>();
  const other: FleetRun[] = [];
  const byPath = new Map(projects.map((p) => [trim(p.path), p.id]));
  for (const run of view.runs) {
    const id = run.project_id ?? byPath.get(trim(run.repo_path)) ?? null;
    if (id && projects.some((p) => p.id === id)) byProject.set(id, [...(byProject.get(id) ?? []), run]);
    else other.push(run);
  }
  const groups: { id: string; project: Extract<TreeNode, { kind: "project" }>["project"]; runs: FleetRun[] }[] = [];
  for (const p of projects) {
    const runs = byProject.get(p.id);
    if (runs) groups.push({ id: `project:${p.id}`, project: { id: p.id, name: p.name, repo: p.repo, runs: 0, running: 0 }, runs });
  }
  if (other.length) {
    // Grouped by repository, newest run first within each.
    const sorted = [...other].sort((a, b) => a.repo_path.localeCompare(b.repo_path) || b.created_at.localeCompare(a.created_at));
    groups.push({ id: OTHER_REPOS, project: { id: null, name: "", repo: null, runs: 0, running: 0 }, runs: sorted });
  }

  for (const group of groups) {
    const running = group.runs.reduce((n, r) => n + r.agents.filter((a) => a.status === "running").length, 0);
    add({ kind: "project", ...base(group.id, null, SIZE.project), project: { ...group.project, runs: group.runs.length, running } });
    for (const run of group.runs) addRun(run, group.id);
  }

  function addRun(run: FleetRun, parent: string) {
    const id = runNodeId(run.id);
    const isCollapsed = collapsed.has(id);
    const states = run.agents.map((a) => a.status as NodeState);
    const worst = SEVERITY.find((s) => states.includes(s)) ?? null;
    add({ kind: "run", ...base(id, parent, SIZE.run), run, collapsed: isCollapsed, agentCount: run.agents.length, worst });
    link(parent, id, "tree", false);
    if (isCollapsed) return;

    const team = run.team;
    const lead = team ? run.agents.find((a) => a.team_role === "lead" && !a.team_sub) : undefined;
    // A sub-lead's agent stands for its member (ADR 0058); its own members are the agents with `team_sub`.
    const memberAgents = new Map(run.agents.filter((a) => a.team_role === "member" && a.team_key && !a.team_sub).map((a) => [a.team_key!, a]));
    for (const a of run.agents) if (a.team_role === "lead" && a.team_sub) memberAgents.set(a.team_sub, a);
    // A parallel member's conflict resolver hangs under that member (ADR 0029).
    const resolvers = new Map(
      (team?.members ?? []).flatMap((m) => {
        const agent = run.agents.find((a) => a.node_id === `${team!.node_id}.${m.key}.resolve`);
        return agent ? [[agent.id, m.key] as const] : [];
      }),
    );
    for (const agent of run.agents) {
      if (agent.team_role === "member" || agent.team_sub || resolvers.has(agent.id)) continue;
      const nodeId = agentNodeId(run.id, agent.node_id);
      const role = agent.team_role === "lead" ? "lead" : null;
      add({ kind: "agent", ...base(nodeId, id, role ? SIZE.lead : SIZE.agent), run, agent, role, member: null, team: role ? team : null });
      link(id, nodeId, "tree", agent.status === "running");
    }
    if (!team) return;
    const leadId = lead ? agentNodeId(run.id, lead.node_id) : id;

    // Members the lead grouped hang under a heading, which hangs under the lead; the others stay under the lead.
    const headings = new Map<string, string>();
    for (const member of team.members) {
      const agent = memberAgents.get(member.key) ?? null;
      const nodeId = agentNodeId(run.id, `${team.node_id}.${member.key}`);
      let parentId = leadId;
      if (member.group) {
        parentId = headings.get(member.group) ?? "";
        if (!parentId) {
          parentId = groupNodeId(run.id, member.group);
          headings.set(member.group, parentId);
          const grouped = team.members.filter((m) => m.group === member.group);
          const statuses = grouped.map((m) => (memberAgents.get(m.key)?.status ?? "not_started") as NodeState);
          const worst = SEVERITY.find((s) => statuses.includes(s)) ?? null;
          add({ kind: "group", ...base(parentId, leadId, SIZE.group), run, name: member.group, members: grouped, worst });
          link(leadId, parentId, lead ? "delegates" : "tree", grouped.some((m) => memberAgents.get(m.key)?.status === "running"), lead ? member.turn : undefined);
        }
      }
      add({ kind: "agent", ...base(nodeId, parentId, SIZE.agent), run, agent, role: "member", member, team });
      const running = agent?.status === "running";
      link(parentId, nodeId, member.group ? "tree" : lead ? "delegates" : "tree", running, !member.group && lead ? member.turn : undefined);
      if (lead && (member.status === "succeeded" || member.status === "failed")) link(nodeId, leadId, "reports", false);
      if (member.sub) addSubTeam(run, team, member, agent, nodeId);
    }
    for (const [agentId, key] of resolvers) {
      const agent = run.agents.find((a) => a.id === agentId)!;
      const memberId = agentNodeId(run.id, `${team.node_id}.${key}`);
      const nodeId = agentNodeId(run.id, agent.node_id);
      add({ kind: "agent", ...base(nodeId, memberId, SIZE.agent), run, agent, role: null, member: null, team: null, resolves: key });
      link(memberId, nodeId, "tree", agent.status === "running");
    }
    for (const member of team.members) {
      for (const dep of member.depends_on) {
        if (team.members.some((m) => m.key === dep)) {
          link(agentNodeId(run.id, `${team.node_id}.${dep}`), agentNodeId(run.id, `${team.node_id}.${member.key}`), "after", false);
        }
      }
    }

    if (lead && team.subagents.length) {
      const groupId = subagentsNodeId(run.id);
      const open = expanded.has(groupId);
      add({ kind: "subagents", ...base(groupId, leadId, SIZE.subagents), run, count: team.subagents.length, expanded: open });
      link(leadId, groupId, "tree", false);
      if (open) {
        for (const sub of team.subagents) {
          const subId = `subagent:${sub.task_id}:${sub.tool_use_id}`;
          add({ kind: "subagent", ...base(subId, groupId, SIZE.subagent), run, subagent: sub });
          link(groupId, subId, "tree", sub.status === "started");
        }
      }
    }
  }

  /** A sub-lead's members hang under the sub-lead (ADR 0058): lead → sub-lead → members. */
  function addSubTeam(run: FleetRun, team: TeamView, sub: TeamMemberView, subAgent: FleetAgent | null, subId: string) {
    const members = sub.sub?.members ?? [];
    const agents = new Map(run.agents.filter((a) => a.team_sub === sub.key && a.team_role === "member" && a.team_key).map((a) => [a.team_key!, a]));
    const prefix = `${team.node_id}.${sub.key}`;
    for (const member of members) {
      const nodeId = agentNodeId(run.id, `${prefix}.${member.key}`);
      const agent = agents.get(member.key) ?? null;
      add({ kind: "agent", ...base(nodeId, subId, SIZE.agent), run, agent, role: "member", member: { ...member, sub: null }, team });
      link(subId, nodeId, "delegates", agent?.status === "running", member.turn);
      if (subAgent && (member.status === "succeeded" || member.status === "failed")) link(nodeId, subId, "reports", false);
      for (const dep of member.depends_on) {
        if (members.some((m) => m.key === dep)) link(agentNodeId(run.id, `${prefix}.${dep}`), nodeId, "after", false);
      }
    }
  }

  layout(nodes, roots);
  return { nodes: [...nodes.values()], edges };
}

/** Top-down tidy layout: each subtree gets the width of its children, parents centred over them. */
function layout(nodes: Map<string, TreeNode>, roots: string[]) {
  const depthHeight: number[] = [];
  const measure = (id: string, depth: number): number => {
    const n = nodes.get(id)!;
    depthHeight[depth] = Math.max(depthHeight[depth] ?? 0, n.height);
    const kids = n.children.reduce((sum, c, i) => sum + measure(c, depth + 1) + (i ? H_GAP : 0), 0);
    widths.set(id, Math.max(n.width, kids));
    return widths.get(id)!;
  };
  const widths = new Map<string, number>();
  for (const r of roots) measure(r, 0);
  const top = (depth: number) => depthHeight.slice(0, depth).reduce((s, h) => s + h + V_GAP, 0);

  const place = (id: string, left: number, depth: number) => {
    const n = nodes.get(id)!;
    const width = widths.get(id)!;
    n.position = { x: left + (width - n.width) / 2, y: top(depth) };
    const kids = n.children.reduce((sum, c, i) => sum + widths.get(c)! + (i ? H_GAP : 0), 0);
    let x = left + (width - kids) / 2;
    for (const c of n.children) {
      place(c, x, depth + 1);
      x += widths.get(c)! + H_GAP;
    }
  };
  let x = 0;
  for (const r of roots) {
    place(r, x, 0);
    x += widths.get(r)! + H_GAP * 2;
  }
}

export type TreeMove = "up" | "down" | "left" | "right";

/** Keyboard moves along the tree: up to the parent, down to the first child, left/right among siblings. */
export function moveFocus(nodes: readonly TreeNode[], from: string | null, move: TreeMove): string | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const roots = nodes.filter((n) => !n.parent).map((n) => n.id);
  const node = from ? byId.get(from) : undefined;
  if (!node) return roots[0] ?? null;
  if (move === "up") return node.parent ?? node.id;
  if (move === "down") return node.children[0] ?? node.id;
  const siblings = node.parent ? byId.get(node.parent)!.children : roots;
  const i = siblings.indexOf(node.id) + (move === "left" ? -1 : 1);
  return siblings[Math.max(0, Math.min(siblings.length - 1, i))] ?? node.id;
}

/** Every run node id, for Collapse all. */
export function runIds(view: FleetView | null): string[] {
  return (view?.runs ?? []).map((r) => runNodeId(r.id));
}

/** What a tree node can ask of its canvas (provided by FleetTree). */
export type TreeActions = {
  focused: Ref<string | null>;
  selected: Ref<string | null>;
  /** Fold or unfold a run, or open or close a lead's sub-agents. */
  toggle: (id: string) => void;
  /** Open an agent's panel; a team run opens its lead chat. */
  open: (runId: string, nodeId: string) => void;
  /** Instructions sent from a card since the view was last fetched. */
  sentSince: (taskId: string) => number;
  sent: (taskId: string) => void;
};
export const TREE_ACTIONS: InjectionKey<TreeActions> = Symbol("tree-actions");
