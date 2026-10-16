import { parseJudgeVerdict, type FlowNode, type JudgeVerdict } from "@navarch/contracts";
import { evaluate, parseExpr, truthy, type Scope } from "./expr.ts";
import type { NodeToStart, RunContext, Step, TaskState } from "./flow.ts";

type CompeteNode = Extract<FlowNode, { type: "compete" }>;

const ACTIVE = new Set(["pending", "ready", "waiting_approval", "blocked", "running", "paused", "interrupted"]);

export const competeTaskId = {
  competitor: (node: string, key: string) => `${node}.${key}`,
  verify: (node: string, key: string) => `${node}.${key}.verify`,
  compare: (node: string) => `${node}.compare`,
  judge: (node: string) => `${node}.judge`,
  approval: (node: string) => `${node}.approve_pick`,
  adopt: (node: string) => `${node}.adopt`,
};

export const competitorKeys = (count: number) => Array.from({ length: count }, (_, i) => `c${i + 1}`);

/** Competitor summaries in the judge's prompt are bounded; the full output stays in the task. */
export const COMPETITOR_SUMMARY_CAP = 2_000;

/** Where one competitor is: implementing or checking, a finalist (checks passed), or out. */
export type Competitor = {
  key: string;
  state: "working" | "finalist" | "out";
  /** Implement iterations so far. */
  iterations: number;
  summary: string | undefined;
  /** Why it is out. */
  reason?: string;
};

export type CompeteState = {
  competitors: Competitor[];
  finalists: string[];
  verdict: JudgeVerdict | undefined;
  /** Why the latest judge answer is not a valid verdict. */
  verdictError: string | undefined;
  winner: string | undefined;
  chosen_by: "judge" | "user" | "only_finalist" | undefined;
  adopted: boolean;
};

const latest = (tasks: TaskState[], nodeId: string, iteration?: number) =>
  tasks.filter((t) => t.node_id === nodeId && (iteration === undefined || t.iteration === iteration)).sort((a, b) => a.iteration - b.iteration).at(-1);

const summaryOf = (t: TaskState | undefined) => (typeof t?.outputs?.summary === "string" ? t.outputs.summary : undefined);

function competitorOf(nodeId: string, key: string, tasks: TaskState[], maxFix: number): Competitor {
  const impl = latest(tasks, competeTaskId.competitor(nodeId, key));
  const iterations = impl?.iteration ?? 0;
  const c: Competitor = { key, state: "working", iterations, summary: summaryOf(impl) };
  if (!impl || ACTIVE.has(impl.status)) return c;
  if (impl.status !== "succeeded") return { ...c, state: "out", reason: impl.status === "failed" ? "the agent failed" : `the agent was ${impl.status}` };
  const verify = latest(tasks, competeTaskId.verify(nodeId, key), iterations);
  if (!verify || ACTIVE.has(verify.status)) return c;
  if (verify.status !== "succeeded") return { ...c, state: "out", reason: `the checks ${verify.status}` };
  if (verify.outputs?.passed !== false) return { ...c, state: "finalist" };
  if (iterations < maxFix) return c;
  const failures = Array.isArray(verify.outputs.blocking_failures) ? verify.outputs.blocking_failures.map(String) : [];
  return { ...c, state: "out", reason: `checks still failed after ${iterations} iteration(s)${failures.length ? `: ${failures.join("; ")}` : ""}` };
}

/**
 * What a compete node's tasks say so far (ADR 0031). Pure, so the engine and the UI projection
 * agree. `maxFix` only decides whether a competitor whose checks failed may still be fixed.
 */
export function competeState(nodeId: string, count: number, tasks: TaskState[], maxFix = Infinity): CompeteState {
  const competitors = competitorKeys(count).map((key) => competitorOf(nodeId, key, tasks, maxFix));
  const finalists = competitors.filter((c) => c.state === "finalist").map((c) => c.key);
  let verdict: JudgeVerdict | undefined;
  let verdictError: string | undefined;
  const judge = latest(tasks, competeTaskId.judge(nodeId));
  if (judge?.status === "succeeded") {
    const parsed = parseJudgeVerdict(summaryOf(judge) ?? "", finalists);
    if (parsed.ok) verdict = parsed.verdict;
    else verdictError = parsed.error;
  }
  const pick = latest(tasks, competeTaskId.approval(nodeId));
  const choice = pick?.status === "succeeded" && typeof pick.outputs?.choice === "string" ? pick.outputs.choice : undefined;
  const proposed = finalists.length === 1 ? finalists[0] : verdict?.ranking[0]?.competitor;
  const winner = choice && finalists.includes(choice) ? choice : proposed;
  const chosen_by = !winner ? undefined : finalists.length === 1 ? "only_finalist" : winner !== proposed ? "user" : "judge";
  const adopt = latest(tasks, competeTaskId.adopt(nodeId));
  return { competitors, finalists, verdict, verdictError, winner, chosen_by, adopted: adopt?.status === "succeeded" && adopt.outputs?.merged === true };
}

function num(value: number | string, scope: Scope): number {
  return typeof value === "number" ? value : Number(evaluate(parseExpr(value), scope));
}

/** The number of competitors, checked against the node's 2–5 also when it comes from a param. */
export function competitorCount(node: CompeteNode, scope: Scope): number {
  const n = num(node.competitors, scope);
  if (!Number.isInteger(n) || n < 2 || n > 5) throw new Error(`${node.id}: competitors must be 2 to 5, got ${n}`);
  return n;
}

/**
 * The next step inside a compete node, or undefined once the winner is adopted. Order:
 * competitors (each implement ⇄ verify) → compare → judge (two or more finalists) → pick
 * (approve_pick) → adopt. The pick and the adoption keep the run in `reviewing` with the judge:
 * the run's states only go back from verifying to executing (spec §8.4).
 */
export function competeStep(node: CompeteNode, ctx: RunContext, scope: Scope): Step | undefined {
  let count: number;
  try {
    count = competitorCount(node, scope);
  } catch (err) {
    return { kind: "fail", reason: (err as Error).message };
  }
  const maxFix = num(node.max_fix_iterations, scope);
  const tasks = ctx.tasks;
  const state = competeState(node.id, count, tasks, maxFix);

  let working = false;
  for (const c of state.competitors) {
    if (c.state !== "working") continue;
    const impl = latest(tasks, competeTaskId.competitor(node.id, c.key));
    if (!impl) return start(competitorNode(node.id, c.key, 1, undefined), "executing");
    if (ACTIVE.has(impl.status)) {
      working = true;
      continue;
    }
    const verify = latest(tasks, competeTaskId.verify(node.id, c.key), impl.iteration);
    if (!verify) return start(verifyNode(node.id, c.key, impl.iteration), "verifying");
    if (ACTIVE.has(verify.status)) {
      working = true;
      continue;
    }
    // The checks failed and the competitor may still fix them.
    return start(competitorNode(node.id, c.key, impl.iteration + 1, verify.outputs?.blocking_failures), "executing");
  }
  if (working) return { kind: "wait" };
  if (!state.finalists.length) return { kind: "fail", reason: `no competitor of ${node.id} passed the checks` };

  const compare = latest(tasks, competeTaskId.compare(node.id));
  if (!compare) return start(compareNode(node.id, state.finalists), "verifying");
  if (ACTIVE.has(compare.status)) return { kind: "wait" };
  if (compare.status !== "succeeded") return { kind: "fail", reason: `comparing the competitors ${compare.status}` };

  if (state.finalists.length > 1) {
    const judge = latest(tasks, competeTaskId.judge(node.id));
    if (!judge) return start(judgeNode(node, 1, state, compare, undefined), "reviewing");
    if (ACTIVE.has(judge.status)) return { kind: "wait" };
    if (judge.status !== "succeeded") return { kind: "fail", reason: `the judge ${judge.status}` };
    if (!state.verdict) {
      if (judge.iteration >= 2) return { kind: "fail", reason: `the judge gave no valid ranking twice: ${state.verdictError}` };
      const reason = `Your last answer did not end with a valid ranking: ${state.verdictError}. End this answer with a valid \`\`\`navarch-judge block.`;
      return start(judgeNode(node, judge.iteration + 1, state, compare, reason), "reviewing");
    }
  }

  const approve = typeof node.approve_pick === "boolean" ? node.approve_pick : truthy(evaluate(parseExpr(node.approve_pick), scope));
  if (approve) {
    const pick = latest(tasks, competeTaskId.approval(node.id));
    if (!pick) return start(pickNode(node.id, state), "reviewing");
    if (ACTIVE.has(pick.status)) return { kind: "wait" };
    if (pick.status !== "succeeded") return { kind: "fail", reason: `the pick was ${pick.status}` };
  }

  const adopt = latest(tasks, competeTaskId.adopt(node.id));
  if (!adopt) return start(adoptNode(node.id, state.winner!), "reviewing");
  if (ACTIVE.has(adopt.status)) return { kind: "wait" };
  if (!state.adopted) return { kind: "fail", reason: `adopting ${state.winner} ${adopt.status === "succeeded" ? "did not merge" : adopt.status}` };
  return undefined;
}

/** The node's outputs once a winner is known: its summary and why it won. */
export function competeOutputs(nodeId: string, count: number, tasks: TaskState[]): { summary: string; winner: string } | undefined {
  const state = competeState(nodeId, count, tasks);
  if (!state.adopted || !state.winner) return undefined;
  const summary = state.competitors.find((c) => c.key === state.winner)?.summary ?? "(no summary)";
  const rank = state.verdict?.ranking.find((r) => r.competitor === state.winner);
  const why = state.chosen_by === "only_finalist"
    ? "The only competitor whose checks passed."
    : state.chosen_by === "user"
      ? `Chosen by the user over the judge's ${state.verdict?.ranking[0]?.competitor}`
      : `Chosen by the judge (${rank?.score}/10): ${rank?.reason}`;
  return { summary: `${summary}\n\n${why}`, winner: state.winner };
}

function start(s: Omit<NodeToStart, "stage">, stage: NodeToStart["stage"]): Step {
  return { kind: "start", start: { ...s, stage } };
}

function competitorNode(nodeId: string, key: string, iteration: number, failures: unknown): Omit<NodeToStart, "stage"> {
  return {
    node: { id: competeTaskId.competitor(nodeId, key), type: "agent", profile: "implementer" },
    iteration,
    inputs: iteration > 1 ? { previous_failures: failures } : {},
    show: [],
    compete: { node_id: nodeId, role: "competitor", key },
  };
}

function verifyNode(nodeId: string, key: string, iteration: number): Omit<NodeToStart, "stage"> {
  return {
    node: { id: competeTaskId.verify(nodeId, key), type: "action", uses: "verification.run" },
    iteration,
    inputs: {},
    show: [],
    compete: { node_id: nodeId, role: "verify", key },
  };
}

function compareNode(nodeId: string, finalists: string[]): Omit<NodeToStart, "stage"> {
  return {
    node: { id: competeTaskId.compare(nodeId), type: "action", uses: "compete.compare" },
    iteration: 1,
    inputs: { finalists },
    show: [],
    compete: { node_id: nodeId, role: "compare" },
  };
}

function cap(text: string): string {
  return text.length <= COMPETITOR_SUMMARY_CAP ? text : `${text.slice(0, COMPETITOR_SUMMARY_CAP)}\n[cut: ${text.length - COMPETITOR_SUMMARY_CAP} more characters]`;
}

function judgeNode(node: CompeteNode, iteration: number, state: CompeteState, compare: TaskState, reason: string | undefined): Omit<NodeToStart, "stage"> {
  const finalists = state.competitors.filter((c) => c.state === "finalist");
  return {
    node: { id: competeTaskId.judge(node.id), type: "agent", profile: node.judge.profile },
    iteration,
    inputs: {
      finalists: finalists.map((c) => c.key),
      summaries: finalists.map((c) => `${c.key}: ${c.summary ? cap(c.summary) : "(no summary)"}`),
      comparison: compare.outputs?.finalists,
      ...(reason ? { reason } : {}),
    },
    show: [],
    compete: { node_id: node.id, role: "judge" },
  };
}

function pickNode(nodeId: string, state: CompeteState): Omit<NodeToStart, "stage"> {
  const ranking = state.verdict?.ranking ?? [];
  const order = ranking.length ? ranking.map((r) => r.competitor) : state.finalists;
  const lines = order.map((key, i) => {
    const r = ranking.find((x) => x.competitor === key);
    const c = state.competitors.find((x) => x.key === key)!;
    return `${i + 1}. ${key}${r ? ` (${r.score}/10): ${r.reason}` : ""}\n${c.summary ? cap(c.summary) : "(no summary)"}`;
  });
  return {
    node: { id: competeTaskId.approval(nodeId), type: "approval" },
    iteration: 1,
    inputs: {},
    show: [
      { path: "judge", value: state.verdict?.summary ?? "Only one competitor passed the checks." },
      { path: "ranking", value: lines },
    ],
    choices: order,
    compete: { node_id: nodeId, role: "approval" },
  };
}

function adoptNode(nodeId: string, winner: string): Omit<NodeToStart, "stage"> {
  return {
    node: { id: competeTaskId.adopt(nodeId), type: "action", uses: "compete.adopt" },
    iteration: 1,
    inputs: { winner },
    show: [],
    compete: { node_id: nodeId, role: "adopt" },
  };
}
