import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { competeState, next, parseFlow, progress, resolveParams, type RunContext, type Step, type TaskState } from "../src/index.ts";

const flow = parseFlow(readFileSync(fileURLToPath(new URL("../../../flows/compete.yaml", import.meta.url)), "utf8"));

function ctx(tasks: TaskState[], params: Record<string, number | string | boolean> = {}, autonomy = 3): RunContext {
  return { params: { ...resolveParams(flow), ...params }, project: { autonomy_level: autonomy, work_item: false }, tasks, skipped: [] };
}
const task = (node_id: string, outputs: Record<string, unknown> = {}, iteration = 1, status: TaskState["status"] = "succeeded"): TaskState => ({ node_id, iteration, status, outputs });
const started = (step: Step) => {
  if (step.kind !== "start") throw new Error(`expected start, got ${JSON.stringify(step)}`);
  return step.start;
};

/** What the Orchestrator does: start every step the engine returns until it says something else. */
function startAll(tasks: TaskState[], params: Record<string, number | string | boolean> = {}, autonomy = 3): string[] {
  const ids: string[] = [];
  for (;;) {
    const step = next(flow, ctx(tasks, params, autonomy));
    if (step.kind !== "start") return ids;
    ids.push(`${step.start.node.id}#${step.start.iteration}`);
    tasks.push(task(step.start.node.id, {}, step.start.iteration, "ready"));
  }
}
const finish = (tasks: TaskState[], id: string, outputs: Record<string, unknown> = {}, status: TaskState["status"] = "succeeded", iteration = 1) => {
  const t = tasks.find((x) => x.node_id === id && x.iteration === iteration);
  if (!t) throw new Error(`no task ${id}#${iteration}`);
  t.status = status;
  t.outputs = outputs;
};
const verdict = (ranking: [string, number][]) => ({
  summary: "I compared them.\n```navarch-judge\n" + JSON.stringify({ summary: "c2 is cleaner", ranking: ranking.map(([competitor, score]) => ({ competitor, score, reason: `${competitor} reason` })) }) + "\n```",
});

/** Every competitor implemented and its checks ran once, with these results. */
function implemented(tasks: TaskState[], results: Record<string, boolean | "failed">) {
  for (const [key, result] of Object.entries(results)) {
    if (result === "failed") {
      finish(tasks, `compete.${key}`, {}, "failed");
      continue;
    }
    finish(tasks, `compete.${key}`, { summary: `${key} summary` });
  }
  startAll(tasks);
  for (const [key, result] of Object.entries(results)) {
    if (result !== "failed") finish(tasks, `compete.${key}.verify`, result ? { passed: true } : { passed: false, blocking_failures: [`${key} test`] });
  }
}

describe("compete node (ADR 0031)", () => {
  it("starts every competitor at once, each in its own worktree", () => {
    const tasks: TaskState[] = [];
    const first = started(next(flow, ctx(tasks)));
    expect(first).toMatchObject({ node: { id: "compete.c1", type: "agent", profile: "implementer" }, stage: "executing", compete: { node_id: "compete", role: "competitor", key: "c1" } });
    expect(startAll(tasks)).toEqual(["compete.c1#1", "compete.c2#1", "compete.c3#1"]);
    expect(startAll([], { competitors: 2 })).toEqual(["compete.c1#1", "compete.c2#1"]);
  });

  it("verifies each competitor in its own worktree and fixes it up to max_fix_iterations", () => {
    const tasks: TaskState[] = [];
    startAll(tasks, { competitors: 2 });
    finish(tasks, "compete.c1", { summary: "c1" });
    const verify = started(next(flow, ctx(tasks, { competitors: 2 })));
    expect(verify).toMatchObject({ node: { id: "compete.c1.verify", type: "action", uses: "verification.run" }, stage: "verifying", compete: { role: "verify", key: "c1" } });
    startAll(tasks, { competitors: 2 });
    finish(tasks, "compete.c1.verify", { passed: false, blocking_failures: ["npm test"] });
    const fix = started(next(flow, ctx(tasks, { competitors: 2 })));
    expect(fix).toMatchObject({ node: { id: "compete.c1" }, iteration: 2, inputs: { previous_failures: ["npm test"] } });
    startAll(tasks, { competitors: 2 });
    finish(tasks, "compete.c1", { summary: "c1 again" }, "succeeded", 2);
    expect(startAll(tasks, { competitors: 2 })).toEqual(["compete.c1.verify#2"]);
    finish(tasks, "compete.c1.verify", { passed: false, blocking_failures: ["npm test"] }, "succeeded", 2);
    // c1 is out after 2 iterations; c2 still runs.
    expect(next(flow, ctx(tasks, { competitors: 2 }))).toEqual({ kind: "wait" });
    expect(competeState("compete", 2, tasks, 2).competitors[0]).toMatchObject({ key: "c1", state: "out", iterations: 2, reason: "checks still failed after 2 iteration(s): npm test" });
  });

  it("compares the finalists once every competitor finished; a failed agent is out", () => {
    const tasks: TaskState[] = [];
    startAll(tasks);
    implemented(tasks, { c1: true, c2: true, c3: "failed" });
    const compare = started(next(flow, ctx(tasks)));
    expect(compare).toMatchObject({ node: { id: "compete.compare", type: "action", uses: "compete.compare" }, inputs: { finalists: ["c1", "c2"] }, compete: { role: "compare" } });
    expect(competeState("compete", 3, tasks).competitors[2]).toMatchObject({ key: "c3", state: "out", reason: "the agent failed" });
  });

  it("fails without a finalist", () => {
    const tasks: TaskState[] = [];
    startAll(tasks, { competitors: 2, max_fix_iterations: 1 });
    implemented(tasks, { c1: false, c2: "failed" });
    expect(next(flow, ctx(tasks, { competitors: 2, max_fix_iterations: 1 }))).toEqual({ kind: "fail", reason: "no competitor of compete passed the checks" });
  });

  it("asks the judge with each finalist's summary and the comparison, read-only", () => {
    const tasks: TaskState[] = [];
    startAll(tasks);
    implemented(tasks, { c1: true, c2: true, c3: "failed" });
    startAll(tasks);
    finish(tasks, "compete.compare", { finalists: [{ key: "c1", added: 3 }, { key: "c2", added: 1 }] });
    const judge = started(next(flow, ctx(tasks)));
    expect(judge).toMatchObject({ node: { id: "compete.judge", type: "agent", profile: "judge" }, stage: "reviewing", compete: { role: "judge" } });
    expect(judge.inputs.finalists).toEqual(["c1", "c2"]);
    expect(judge.inputs.summaries).toEqual(["c1: c1 summary", "c2: c2 summary"]);
    expect(judge.inputs.comparison).toEqual([{ key: "c1", added: 3 }, { key: "c2", added: 1 }]);
  });

  it("gives an invalid verdict one more turn, then fails", () => {
    const tasks: TaskState[] = [];
    startAll(tasks, { competitors: 2 });
    implemented(tasks, { c1: true, c2: true });
    startAll(tasks, { competitors: 2 });
    finish(tasks, "compete.compare", { finalists: [] });
    startAll(tasks, { competitors: 2 });
    finish(tasks, "compete.judge", verdict([["c1", 5]]));
    const again = started(next(flow, ctx(tasks, { competitors: 2 })));
    expect(again).toMatchObject({ node: { id: "compete.judge" }, iteration: 2 });
    expect(again.inputs.reason).toMatch(/leaves out c2/);
    startAll(tasks, { competitors: 2 });
    finish(tasks, "compete.judge", { summary: "no block" }, "succeeded", 2);
    expect(next(flow, ctx(tasks, { competitors: 2 }))).toMatchObject({ kind: "fail", reason: expect.stringMatching(/^the judge gave no valid ranking twice: /) });
  });

  it("adopts the judge's winner at autonomy 3, and the node's output says why", () => {
    const tasks: TaskState[] = [];
    startAll(tasks, { competitors: 2 });
    implemented(tasks, { c1: true, c2: true });
    startAll(tasks, { competitors: 2 });
    finish(tasks, "compete.compare", { finalists: [] });
    startAll(tasks, { competitors: 2 });
    finish(tasks, "compete.judge", verdict([["c2", 9], ["c1", 6]]));
    const adopt = started(next(flow, ctx(tasks, { competitors: 2 })));
    expect(adopt).toMatchObject({ node: { id: "compete.adopt", type: "action", uses: "compete.adopt" }, inputs: { winner: "c2" }, compete: { role: "adopt" } });
    startAll(tasks, { competitors: 2 });
    finish(tasks, "compete.adopt", { merged: true, winner: "c2" });
    const review = started(next(flow, ctx(tasks, { competitors: 2 })));
    expect(review.node.id).toBe("review");
    expect(review.inputs.implementation).toBe("c2 summary\n\nChosen by the judge (9/10): c2 reason");
    expect(competeState("compete", 2, tasks)).toMatchObject({ winner: "c2", chosen_by: "judge" });
  });

  it("below autonomy 3 asks a human to pick among the finalists, the judge's first as default", () => {
    const tasks: TaskState[] = [];
    startAll(tasks, { competitors: 2 }, 2);
    implemented(tasks, { c1: true, c2: true });
    startAll(tasks, { competitors: 2 }, 2);
    finish(tasks, "compete.compare", { finalists: [] });
    startAll(tasks, { competitors: 2 }, 2);
    finish(tasks, "compete.judge", verdict([["c2", 9], ["c1", 6]]));
    const pick = started(next(flow, ctx(tasks, { competitors: 2 }, 2)));
    expect(pick).toMatchObject({ node: { id: "compete.approve_pick", type: "approval" }, stage: "reviewing", choices: ["c2", "c1"], compete: { role: "approval" } });
    expect(pick.show.map((s) => s.path)).toEqual(["judge", "ranking"]);
    startAll(tasks, { competitors: 2 }, 2);
    finish(tasks, "compete.approve_pick", { approved: true, choice: "c1" });
    expect(started(next(flow, ctx(tasks, { competitors: 2 }, 2))).inputs).toEqual({ winner: "c1" });
    startAll(tasks, { competitors: 2 }, 2);
    finish(tasks, "compete.adopt", { merged: true, winner: "c1" });
    expect(competeState("compete", 2, tasks)).toMatchObject({ winner: "c1", chosen_by: "user" });
    expect(started(next(flow, ctx(tasks, { competitors: 2 }, 2))).inputs.implementation).toBe("c1 summary\n\nChosen by the user over the judge's c2");
  });

  it("skips the judge with one finalist", () => {
    const tasks: TaskState[] = [];
    startAll(tasks, { competitors: 2, max_fix_iterations: 1 });
    implemented(tasks, { c1: false, c2: true });
    startAll(tasks, { competitors: 2, max_fix_iterations: 1 });
    finish(tasks, "compete.compare", { finalists: [] });
    expect(started(next(flow, ctx(tasks, { competitors: 2, max_fix_iterations: 1 }))).node.id).toBe("compete.adopt");
    expect(competeState("compete", 2, tasks)).toMatchObject({ winner: "c2", chosen_by: "only_finalist" });
  });

  it("counts as one step of progress, once adopted", () => {
    const tasks: TaskState[] = [];
    startAll(tasks, { competitors: 2 });
    expect(progress(flow, ctx(tasks, { competitors: 2 }))).toEqual({ done: 0, total: 3 });
    implemented(tasks, { c1: "failed", c2: true });
    startAll(tasks, { competitors: 2 });
    finish(tasks, "compete.compare", { finalists: [] });
    startAll(tasks, { competitors: 2 });
    expect(progress(flow, ctx(tasks, { competitors: 2 }))).toEqual({ done: 0, total: 3 });
    finish(tasks, "compete.adopt", { merged: true, winner: "c2" });
    expect(progress(flow, ctx(tasks, { competitors: 2 }))).toEqual({ done: 1, total: 3 });
  });

  it("refuses a competitors param outside 2–5", () => {
    expect(next(flow, ctx([], { competitors: 7 }))).toEqual({ kind: "fail", reason: "compete: competitors must be 2 to 5, got 7" });
  });
});
