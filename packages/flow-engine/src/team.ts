import { parseTeamPlan, type FlowNode, type TeamMemberSpec, type TeamPlan } from "@navarch/contracts";
import { evaluate, parseExpr, truthy, type Scope } from "./expr.ts";
import type { NodeToStart, RunContext, Step, TaskState } from "./flow.ts";

type TeamNode = Extract<FlowNode, { type: "team" }>;

const ACTIVE = new Set(["pending", "ready", "waiting_approval", "blocked", "running", "paused", "interrupted"]);

/** One lead turn, read from its task. */
type Turn = { iteration: number; task: TaskState; plan?: TeamPlan; error?: string };

/** A member as the team knows it: what the lead asked, and how far it got. */
export type TeamMember = TeamMemberSpec & { turn: number; status: string; summary: string | undefined; skipped?: string };

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
};

const latest = (tasks: TaskState[], nodeId: string, iteration?: number) =>
  tasks.filter((t) => t.node_id === nodeId && (iteration === undefined || t.iteration === iteration)).sort((a, b) => a.iteration - b.iteration).at(-1);

export function teamState(teamId: string, tasks: TaskState[]): TeamState {
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
  // A member whose dependency did not succeed is not started.
  for (const m of members) {
    if (m.status !== "planned") continue;
    const failed = m.depends_on.map((d) => members.find((x) => x.key === d)!).find((d) => d.skipped || (!ACTIVE.has(d.status) && d.status !== "planned" && d.status !== "succeeded"));
    if (failed) m.skipped = `${failed.key} ${failed.skipped ? "was not started" : failed.status}`;
  }
  const summary = turns.filter((t) => t.plan).at(-1)?.plan?.summary;
  return { turns, members, summary };
}

function num(value: number | string, scope: Scope): number {
  return typeof value === "number" ? value : Number(evaluate(parseExpr(value), scope));
}

/**
 * The next step inside a team node, or undefined when the team finished and the chain goes on.
 * Order of a turn: lead → (first-plan approval) → members in dependency order → verify → next turn.
 */
export function teamStep(node: TeamNode, ctx: RunContext, scope: Scope): Step | undefined {
  const state = teamState(node.id, ctx.tasks);
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
  const approve = typeof node.approve_first_plan === "boolean" ? node.approve_first_plan : truthy(evaluate(parseExpr(node.approve_first_plan), scope));
  const firstWithMembers = state.turns.find((x) => x.plan?.members.length);
  if (approve && firstWithMembers === turn) {
    const approval = latest(ctx.tasks, teamTaskId.approval(node.id));
    if (!approval) return start(approvalNode(node, plan), "awaiting_approval");
    if (ACTIVE.has(approval.status)) return { kind: "wait" };
    if (approval.status !== "succeeded") return { kind: "fail", reason: `the team plan was ${approval.status}` };
  }

  for (const m of state.members.filter((x) => x.turn === t)) {
    if (m.skipped) continue;
    if (m.status === "planned") return start(memberNode(node, m, state), "executing", undefined, m);
    if (ACTIVE.has(m.status)) return { kind: "wait" };
  }

  if (plan.question) return nextTurn(`The user was asked: "${plan.question}". Their answer is in the operator instruction.`, "question");

  const verify = latest(ctx.tasks, teamTaskId.verify(node.id), t);
  if (!verify) return start({ node: { id: teamTaskId.verify(node.id), type: "action", uses: "verification.run" }, iteration: t, inputs: {}, show: [], team: { node_id: node.id, role: "verify" } }, "verifying");
  if (ACTIVE.has(verify.status)) return { kind: "wait" };
  const passed = verify.status === "succeeded" && verify.outputs?.passed !== false;
  if (plan.done && passed) return undefined;
  return nextTurn(plan.done ? "You said the work is done, but the checks still fail. Fix them or delegate the fix." : "The members of your last turn finished. Read their results and the checks, then decide the next step.");
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
  const state = m.skipped ? `not started: ${m.skipped}` : m.status;
  const head = `${m.key} (${m.profile}, turn ${m.turn}): ${m.title}: ${state}`;
  return m.summary ? `${head}\n${cap(m.summary)}` : head;
}

function memberNode(node: TeamNode, m: TeamMember, state: TeamState): Omit<NodeToStart, "stage"> {
  const deps = m.depends_on.map((d) => state.members.find((x) => x.key === d)!).map((d) => `${d.key}: ${d.summary ? cap(d.summary) : "(no summary)"}`);
  return {
    node: { id: teamTaskId.member(node.id, m.key), type: "agent", profile: m.profile },
    iteration: 1,
    inputs: { brief: m.brief, ...(deps.length ? { depends_on: deps } : {}) },
    show: [],
    team: { node_id: node.id, role: "member", key: m.key },
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

