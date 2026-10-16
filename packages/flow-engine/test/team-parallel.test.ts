import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { next, parseFlow, renderInputs, resolveParams, teamState, type RunContext, type Step, type TaskState } from "../src/index.ts";

const flow = parseFlow(readFileSync(fileURLToPath(new URL("../../../flows/team.yaml", import.meta.url)), "utf8"));

type Plan = { summary?: string; done?: boolean; members?: Record<string, unknown>[] };
const plan = (p: Plan) => ({ summary: "```navarch-team\n" + JSON.stringify({ summary: "turn summary", done: false, members: [], ...p }) + "\n```" });
const member = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: `Do ${key}`, brief: `Brief ${key}`, profile: "implementer", ...extra });

function ctx(tasks: TaskState[], params: Record<string, number | string | boolean> = {}): RunContext {
  return { params: { ...resolveParams(flow), ...params }, project: { autonomy_level: 3, work_item: false }, tasks, skipped: [] };
}
const task = (node_id: string, outputs: Record<string, unknown> = {}, iteration = 1, status: TaskState["status"] = "succeeded"): TaskState => ({ node_id, iteration, status, outputs });
const started = (step: Step) => {
  if (step.kind !== "start") throw new Error(`expected start, got ${JSON.stringify(step)}`);
  return step.start;
};

/** What the Orchestrator does: start every step the engine returns until it says wait. */
function startAll(tasks: TaskState[], params: Record<string, number | string | boolean> = {}): string[] {
  const ids: string[] = [];
  for (;;) {
    const step = next(flow, ctx(tasks, params));
    if (step.kind !== "start") return ids;
    ids.push(`${step.start.node.id}#${step.start.iteration}`);
    tasks.push(task(step.start.node.id, {}, step.start.iteration, "ready"));
  }
}
const finish = (tasks: TaskState[], id: string, outputs: Record<string, unknown> = {}, status: TaskState["status"] = "succeeded", iteration = 1) => {
  const t = tasks.find((x) => x.node_id === id && x.iteration === iteration)!;
  t.status = status;
  t.outputs = outputs;
};

describe("parallel team members (ADR 0029)", () => {
  it("the team Flow is parallel by default", () => {
    expect(resolveParams(flow)).toMatchObject({ parallel: true, max_parallel: 3 });
  });

  it("starts independent members together, each in its own worktree, up to max_parallel", () => {
    const tasks = [task("team.lead", plan({ members: [member("a"), member("b"), member("c"), member("d")] }))];
    const first = started(next(flow, ctx(tasks)));
    expect(first).toMatchObject({ node: { id: "team.a" }, team: { role: "member", key: "a", own_worktree: true } });
    expect(startAll(tasks)).toEqual(["team.a#1", "team.b#1", "team.c#1"]);
    finish(tasks, "team.b", { summary: "b done" });
    // b's integration and d (a slot is free) both start.
    expect(startAll(tasks)).toEqual(["team.b.integrate#1", "team.d#1"]);
  });

  it("merges each editing member back one at a time; a dependant waits for its dependency's merge", () => {
    const tasks = [task("team.lead", plan({ members: [member("a"), member("b"), member("c", { depends_on: ["a"] })] }))];
    expect(startAll(tasks)).toEqual(["team.a#1", "team.b#1"]);
    finish(tasks, "team.a", { summary: "a done" });
    finish(tasks, "team.b", { summary: "b done" });
    expect(startAll(tasks)).toEqual(["team.a.integrate#1"]);
    const integrate = tasks.find((t) => t.node_id === "team.a.integrate")!;
    expect(integrate.status).toBe("ready");
    finish(tasks, "team.a.integrate", { merged: true });
    // c may start now that a is merged; b's integration goes next.
    expect(startAll(tasks)).toEqual(["team.b.integrate#1", "team.c#1"]);
    finish(tasks, "team.b.integrate", { merged: true });
    expect(next(flow, ctx(tasks))).toEqual({ kind: "wait" });
    finish(tasks, "team.c", { summary: "c done" });
    expect(startAll(tasks)).toEqual(["team.c.integrate#1"]);
    finish(tasks, "team.c.integrate", { merged: true });
    expect(startAll(tasks)).toEqual(["team.verify#1"]);
  });

  it("gives the integration's inputs and stage", () => {
    const tasks = [task("team.lead", plan({ members: [member("a")] })), task("team.a", { summary: "a done" })];
    expect(started(next(flow, ctx(tasks)))).toMatchObject({
      node: { id: "team.a.integrate", type: "action", uses: "team.integrate" },
      iteration: 1,
      stage: "executing",
      inputs: { member: "a" },
      team: { node_id: "team", role: "integrate", key: "a" },
    });
  });

  it("sends a conflict to an implementer, then concludes the merge", () => {
    const tasks = [task("team.lead", plan({ members: [member("a")] })), task("team.a", { summary: "a done" }), task("team.a.integrate", { merged: false, conflicts: ["x.ts", "y.ts"] })];
    const resolve = started(next(flow, ctx(tasks)));
    expect(resolve).toMatchObject({ node: { id: "team.a.resolve", type: "agent", profile: "implementer" }, team: { role: "integrate", key: "a" } });
    expect(resolve.team?.own_worktree).toBeUndefined();
    const inputs = renderInputs(resolve.inputs);
    expect(inputs.conflicts).toContain("x.ts");
    expect(inputs.brief).toMatch(/conflict markers/);
    tasks.push(task("team.a.resolve", { summary: "fixed" }));
    expect(started(next(flow, ctx(tasks)))).toMatchObject({ node: { id: "team.a.integrate" }, iteration: 2 });
    tasks.push(task("team.a.integrate", { merged: true }, 2));
    expect(teamState("team", tasks, true).members[0]).toMatchObject({ merge: "merged" });
    expect(started(next(flow, ctx(tasks))).node.id).toBe("team.verify");
  });

  it("concludes or aborts after a failed resolve too, and an unmerged member reaches the lead and skips its dependants", () => {
    const tasks = [
      task("team.lead", plan({ members: [member("a"), member("b", { depends_on: ["a"] })] })),
      task("team.a", { summary: "a done" }),
      task("team.a.integrate", { merged: false, conflicts: ["x.ts"] }),
      task("team.a.resolve", {}, 1, "failed"),
    ];
    expect(started(next(flow, ctx(tasks)))).toMatchObject({ node: { id: "team.a.integrate" }, iteration: 2 });
    tasks.push(task("team.a.integrate", { merged: false, conflicts: ["x.ts"] }, 2));
    const state = teamState("team", tasks, true);
    expect(state.members.map((m) => [m.key, m.merge, m.skipped])).toEqual([
      ["a", "conflict", undefined],
      ["b", undefined, "a not merged"],
    ]);
    expect(started(next(flow, ctx(tasks))).node.id).toBe("team.verify");
    tasks.push(task("team.verify", { passed: true }));
    const lead = renderInputs(started(next(flow, ctx(tasks))).inputs);
    expect(lead.team).toMatch(/a .*not merged: conflict in x\.ts/);
    expect(lead.team).toMatch(/b .*not started: a not merged/);
  });

  it("does not merge read-only members", () => {
    const tasks = [task("team.lead", plan({ members: [member("r", { profile: "researcher" }), member("a", { depends_on: ["r"] })] }))];
    expect(startAll(tasks)).toEqual(["team.r#1"]);
    finish(tasks, "team.r", { summary: "found it" });
    expect(startAll(tasks)).toEqual(["team.a#1"]);
    expect(teamState("team", tasks, true).members[0]!.merge).toBeUndefined();
  });

  it("verifies only after every integration settled", () => {
    const tasks = [task("team.lead", plan({ members: [member("a"), member("b")] })), task("team.a", {}), task("team.b", {}, 1, "failed"), task("team.a.integrate", {}, 1, "running")];
    expect(next(flow, ctx(tasks))).toEqual({ kind: "wait" });
    finish(tasks, "team.a.integrate", { merged: true });
    expect(started(next(flow, ctx(tasks))).node.id).toBe("team.verify");
  });

  it("keeps Phase 1's sequential team with parallel: false", () => {
    const tasks = [task("team.lead", plan({ members: [member("a"), member("b")] }))];
    expect(startAll(tasks, { parallel: false })).toEqual(["team.a#1"]);
    expect(tasks.find((t) => t.node_id === "team.a")).toBeDefined();
    finish(tasks, "team.a", { summary: "ok" });
    expect(startAll(tasks, { parallel: false })).toEqual(["team.b#1"]);
    const s = next(flow, ctx([task("team.lead", plan({ members: [member("a")] }))], { parallel: false }));
    expect(started(s).team?.own_worktree).toBeUndefined();
  });
});
