import { parseTeamPlan, type FlowNode, type TeamMemberSpec, type TeamPlan } from "@navarch/contracts";
import { evaluate, parseExpr, truthy, type Scope } from "./expr.ts";
import type { NodeToStart, RunContext, Step, TaskState } from "./flow.ts";

type TeamNode = Extract<FlowNode, { type: "team" }>;

const ACTIVE = new Set(["pending", "ready", "waiting_approval", "blocked", "running", "paused", "interrupted"]);

/** One lead turn, read from its task. */
type Turn = { iteration: number; task: TaskState; plan?: TeamPlan; error?: string };

/**
 * How a parallel member's branch gets back into the run's worktree (ADR 0029): waiting for its
 * integration, merging, waiting for a conflict to be resolved, merged, or left out after a conflict.
 */
export type MergeState = "pending" | "merging" | "resolving" | "merged" | "conflict";

/** A member as the team knows it: what the lead asked, and how far it got. */
export type TeamMember = TeamMemberSpec & {
  turn: number;
  status: string;
  summary: string | undefined;
  skipped?: string;
  /** Only for editing members of a parallel team, once they succeeded. */
  merge?: MergeState;
  /** Files whose merge conflicted. */
  conflicts?: string[];
};

/** Members whose work is merged back in a parallel team; the other profiles are read-only. */
const EDITS = new Set(["implementer"]);

/** What a team node's tasks say so far (ADR 0022). Pure, so the UI projection and the engine agree. */
export type TeamState = {
  turns: Turn[];
  members: TeamMember[];
  /** The latest valid plan's summary: the team's output. */
  summary: string | undefined;
};

export const teamTaskId = {
  lead: (team: string) => `${team}.lead`,
  verify: (team: string) => `${team}.verify`,
  approval: (team: string) => `${team}.approve_plan`,
  member: (team: string, key: string) => `${team}.${key}`,
  integrate: (team: string, key: string) => `${team}.${key}.integrate`,
  resolve: (team: string, key: string) => `${team}.${key}.resolve`,
};

const latest = (tasks: TaskState[], nodeId: string, iteration?: number) =>
  tasks.filter((t) => t.node_id === nodeId && (iteration === undefined || t.iteration === iteration)).sort((a, b) => a.iteration - b.iteration).at(-1);

/** `parallel`: the team merges its editing members back (ADR 0029), so a dependency is done once merged. */
export function teamState(teamId: string, tasks: TaskState[], parallel = false): TeamState {
  const turns: Turn[] = [];
  const members: TeamMember[] = [];
  for (const task of tasks.filter((t) => t.node_id === teamTaskId.lead(teamId)).sort((a, b) => a.iteration - b.iteration)) {
    const turn: Turn = { iteration: task.iteration, task };
    if (task.status === "succeeded") {
      const parsed = parseTeamPlan(String(task.outputs?.summary ?? ""), members.map((m) => m.key));
      if (parsed.ok) {
        turn.plan = parsed.plan;
        for (const spec of parsed.plan.members) members.push({ ...spec, turn: task.iteration, status: "planned", summary: undefined });
      } else {
        turn.error = parsed.error;
      }
    }
    turns.push(turn);
  }
  for (const m of members) {
    const t = latest(tasks, teamTaskId.member(teamId, m.key));
    if (t) {
      m.status = t.status;
      m.summary = typeof t.outputs?.summary === "string" ? t.outputs.summary : undefined;
    }
  }
  if (parallel) {
    for (const m of members) {
      if (m.status !== "succeeded" || !EDITS.has(m.profile)) continue;
      const merge = mergeOf(teamId, m.key, tasks);
      m.merge = merge.state;
      if (merge.conflicts) m.conflicts = merge.conflicts;
    }
  }
  // A member whose dependency did not succeed, or was not merged, is not started.
  for (const m of members) {
    if (m.status !== "planned") continue;
    const failed = m.depends_on
      .map((d) => members.find((x) => x.key === d)!)
      .find((d) => d.skipped || d.merge === "conflict" || (!ACTIVE.has(d.status) && d.status !== "planned" && d.status !== "succeeded"));
    if (failed) m.skipped = `${failed.key} ${failed.skipped ? "was not started" : failed.merge === "conflict" ? "not merged" : failed.status}`;
  }
  const summary = turns.filter((t) => t.plan).at(-1)?.plan?.summary;
  return { turns, members, summary };
}

/**
 * A succeeded editing member's merge, read from its integration tasks: integrate (1), and after a
 * conflict, resolve then integrate (2), which concludes or aborts the merge.
 */
function mergeOf(teamId: string, key: string, tasks: TaskState[]): { state: MergeState; conflicts?: string[] } {
  const first = latest(tasks, teamTaskId.integrate(teamId, key), 1);
  if (!first) return { state: "pending" };
  if (ACTIVE.has(first.status)) return { state: "merging" };
  if (first.status !== "succeeded") return { state: "conflict" };
  if (first.outputs?.merged === true) return { state: "merged" };
  const conflicts = Array.isArray(first.outputs?.conflicts) ? first.outputs.conflicts.map(String) : [];
  const resolve = latest(tasks, teamTaskId.resolve(teamId, key));
  if (!resolve || ACTIVE.has(resolve.status)) return { state: "resolving", conflicts };
  const second = latest(tasks, teamTaskId.integrate(teamId, key), 2);
  if (!second || ACTIVE.has(second.status)) return { state: "merging", conflicts };
  return second.status === "succeeded" && second.outputs?.merged === true ? { state: "merged" } : { state: "conflict", conflicts };
}

/** The next integration task of a member, "busy" while one runs, or undefined when there is nothing to do. */
function integrationStep(teamId: string, m: TeamMember, tasks: TaskState[]): "busy" | Omit<NodeToStart, "stage"> | undefined {
  if (!m.merge || m.merge === "merged" || m.merge === "conflict") return undefined;
  const first = latest(tasks, teamTaskId.integrate(teamId, m.key), 1);
  if (!first) return integrateNode(teamId, m, 1);
  if (ACTIVE.has(first.status)) return "busy";
  const resolve = latest(tasks, teamTaskId.resolve(teamId, m.key));
  if (!resolve) return resolveNode(teamId, m);
  if (ACTIVE.has(resolve.status)) return "busy";
  const second = latest(tasks, teamTaskId.integrate(teamId, m.key), 2);
  if (!second) return integrateNode(teamId, m, 2);
  return ACTIVE.has(second.status) ? "busy" : undefined;
}

function bool(value: boolean | string, scope: Scope): boolean {
  return typeof value === "boolean" ? value : truthy(evaluate(parseExpr(value), scope));
}

function num(value: number | string, scope: Scope): number {
  return typeof value === "number" ? value : Number(evaluate(parseExpr(value), scope));
}

/**
 * The next step inside a team node, or undefined when the team finished and the chain goes on.
 * Order of a turn: lead → (first-plan approval) → members in dependency order → verify → next turn.
 */
export function teamStep(node: TeamNode, ctx: RunContext, scope: Scope): Step | undefined {
  const parallel = bool(node.parallel, scope);
  const state = teamState(node.id, ctx.tasks, parallel);
  const maxTurns = num(node.max_turns, scope);
  const maxMembers = num(node.max_members, scope);
  const turn = state.turns.at(-1);
  if (!turn) return start(leadNode(node, 1, maxTurns, state, ctx.tasks, undefined), "planning");
  if (ACTIVE.has(turn.task.status)) return { kind: "wait" };
  if (turn.task.status !== "succeeded") return { kind: "fail", reason: `the lead's turn ${turn.iteration} ${turn.task.status}` };
  const t = turn.iteration;
  const nextTurn = (reason: string, blocked?: string): Step => {
    if (t >= maxTurns) return { kind: "fail", reason: `${node.id} stopped after ${t} turn(s) without finishing (max_turns ${maxTurns})` };
    return start(leadNode(node, t + 1, maxTurns, state, ctx.tasks, reason), "executing", blocked);
  };

  if (!turn.plan) {
    if (state.turns.at(-2)?.error) return { kind: "fail", reason: `two invalid team plans in a row: ${turn.error}` };
    return nextTurn(`Your last turn did not end with a valid team plan: ${turn.error}. End this turn with a valid \`\`\`navarch-team block.`);
  }
  const plan = turn.plan;
  if (state.members.length > maxMembers) return { kind: "fail", reason: `the team plan of turn ${t} goes over max_members (${maxMembers})` };

  // The first plan that adds members waits for a human below autonomy level 3.
  const approve = bool(node.approve_first_plan, scope);
  const firstWithMembers = state.turns.find((x) => x.plan?.members.length);
  if (approve && firstWithMembers === turn) {
    const approval = latest(ctx.tasks, teamTaskId.approval(node.id));
    if (!approval) return start(approvalNode(node, plan), "awaiting_approval");
    if (ACTIVE.has(approval.status)) return { kind: "wait" };
    if (approval.status !== "succeeded") return { kind: "fail", reason: `the team plan was ${approval.status}` };
  }

  const ofTurn = state.members.filter((x) => x.turn === t && !x.skipped);
  if (parallel) {
    const step = parallelStep(node, ofTurn, state, ctx.tasks, num(node.max_parallel, scope));
    if (step) return step;
  } else {
    for (const m of ofTurn) {
      if (m.status === "planned") return start(memberNode(node, m, state, false), "executing", undefined, m);
      if (ACTIVE.has(m.status)) return { kind: "wait" };
    }
  }

  if (plan.question) return nextTurn(`The user was asked: "${plan.question}". Their answer is in the operator instruction.`, "question");

  const verify = latest(ctx.tasks, teamTaskId.verify(node.id), t);
  if (!verify) return start({ node: { id: teamTaskId.verify(node.id), type: "action", uses: "verification.run" }, iteration: t, inputs: {}, show: [], team: { node_id: node.id, role: "verify" } }, "verifying");
  if (ACTIVE.has(verify.status)) return { kind: "wait" };
  const passed = verify.status === "succeeded" && verify.outputs?.passed !== false;
  if (plan.done && passed) return undefined;
  return nextTurn(plan.done ? "You said the work is done, but the checks still fail. Fix them or delegate the fix." : "The members of your last turn finished. Read their results and the checks, then decide the next step.");
}

/**
 * A parallel turn (ADR 0029): the next integration when none runs (they share the run's worktree),
 * then any member whose dependencies are done while fewer than `maxParallel` run; wait while
 * anything of the turn is unfinished, and undefined once every member ended and merged or not.
 */
function parallelStep(node: TeamNode, ofTurn: TeamMember[], state: TeamState, tasks: TaskState[], maxParallel: number): Step | undefined {
  const integrations = ofTurn.map((m) => integrationStep(node.id, m, tasks));
  if (!integrations.includes("busy")) {
    const due = integrations.find((x) => x !== undefined && x !== "busy");
    if (due) return start(due, "executing");
  }
  let running = ofTurn.filter((m) => ACTIVE.has(m.status)).length;
  const done = (key: string) => {
    const d = state.members.find((x) => x.key === key)!;
    return d.status === "succeeded" && (d.merge === undefined || d.merge === "merged");
  };
  for (const m of ofTurn) {
    if (m.status !== "planned" || running >= maxParallel || !m.depends_on.every(done)) continue;
    return start(memberNode(node, m, state, true), "executing", undefined, m);
  }
  running = ofTurn.filter((m) => ACTIVE.has(m.status) || m.status === "planned").length;
  return running || integrations.some((x) => x !== undefined) ? { kind: "wait" } : undefined;
}

function start(s: Omit<NodeToStart, "stage" | "blocked" | "prefer">, stage: NodeToStart["stage"], blocked?: string, m?: TeamMember): Step {
  return { kind: "start", start: { ...s, stage, ...(blocked ? { blocked } : {}), ...(m?.prefer ? { prefer: m.prefer } : {}) } };
}

function leadNode(node: TeamNode, iteration: number, maxTurns: number, state: TeamState, tasks: TaskState[], reason: string | undefined): Omit<NodeToStart, "stage"> {
  return {
    node: { id: teamTaskId.lead(node.id), type: "agent", profile: node.lead.profile },
    iteration,
    inputs: {
      turn: `${iteration} of ${maxTurns}`,
      reason,
      team: state.members.length ? state.members.map(describeMember) : undefined,
      checks: checksText(node.id, tasks),
    },
    show: [],
    team: { node_id: node.id, role: "lead" },
  };
}

/** The team's latest verification, as text for the lead. */
function checksText(teamId: string, tasks: TaskState[]): string | undefined {
  const v = latest(tasks, teamTaskId.verify(teamId));
  if (!v) return undefined;
  if (v.outputs?.passed === false) {
    const failures = Array.isArray(v.outputs.blocking_failures) ? v.outputs.blocking_failures.map(String) : [];
    return ["failed:", ...failures.map((f) => `- ${f}`)].join("\n");
  }
  return v.status === "succeeded" ? "passed" : v.status;
}

/** Member summaries in the lead's prompt are bounded; the full output stays in the member's task. */
export const MEMBER_SUMMARY_CAP = 2_000;
function cap(text: string): string {
  return text.length <= MEMBER_SUMMARY_CAP ? text : `${text.slice(0, MEMBER_SUMMARY_CAP)}\n[cut: ${text.length - MEMBER_SUMMARY_CAP} more characters in the member's output]`;
}

function describeMember(m: TeamMember): string {
  const merge = m.merge === "conflict" ? `, not merged: conflict${m.conflicts?.length ? ` in ${m.conflicts.join(", ")}` : ""}` : m.merge === "merged" ? ", merged" : "";
  const state = m.skipped ? `not started: ${m.skipped}` : `${m.status}${merge}`;
  const head = `${m.key} (${m.profile}, turn ${m.turn}): ${m.title}: ${state}`;
  return m.summary ? `${head}\n${cap(m.summary)}` : head;
}

function memberNode(node: TeamNode, m: TeamMember, state: TeamState, ownWorktree: boolean): Omit<NodeToStart, "stage"> {
  const deps = m.depends_on.map((d) => state.members.find((x) => x.key === d)!).map((d) => `${d.key}: ${d.summary ? cap(d.summary) : "(no summary)"}`);
  return {
    node: { id: teamTaskId.member(node.id, m.key), type: "agent", profile: m.profile },
    iteration: 1,
    inputs: { brief: m.brief, ...(deps.length ? { depends_on: deps } : {}) },
    show: [],
    team: { node_id: node.id, role: "member", key: m.key, ...(ownWorktree ? { own_worktree: true } : {}) },
  };
}

function integrateNode(teamId: string, m: TeamMember, iteration: 1 | 2): Omit<NodeToStart, "stage"> {
  return {
    node: { id: teamTaskId.integrate(teamId, m.key), type: "action", uses: "team.integrate" },
    iteration,
    inputs: { member: m.key, title: m.title },
    show: [],
    team: { node_id: teamId, role: "integrate", key: m.key },
  };
}

/** An implementer that removes the conflict markers a member's merge left; Navarch concludes the merge. */
function resolveNode(teamId: string, m: TeamMember): Omit<NodeToStart, "stage"> {
  const brief = [
    `Merging team member "${m.key}" (${m.title}) into this worktree left conflicts in the files listed in <input name="conflicts">.`,
    "Edit each of them so that no conflict markers remain (lines starting with <<<<<<<, ======= or >>>>>>>), keeping what both sides meant to do.",
    "Do not run git: Navarch concludes the merge once the markers are gone.",
  ].join("\n");
  return {
    node: { id: teamTaskId.resolve(teamId, m.key), type: "agent", profile: "implementer" },
    iteration: 1,
    inputs: { brief, conflicts: m.conflicts ?? [], ...(m.summary ? { member_summary: cap(m.summary) } : {}) },
    show: [],
    team: { node_id: teamId, role: "integrate", key: m.key },
  };
}

function approvalNode(node: TeamNode, plan: TeamPlan): Omit<NodeToStart, "stage"> {
  const id = teamTaskId.approval(node.id);
  const members = plan.members.map((m) => `${m.key} (${m.profile}${m.prefer ? `, prefers ${m.prefer}` : ""}): ${m.title}\n${m.brief}`);
  return {
    node: { id, type: "approval" },
    iteration: 1,
    inputs: {},
    show: [
      { path: "team plan", value: plan.summary },
      { path: "team members", value: members },
    ],
    team: { node_id: node.id, role: "approval" },
  };
}

