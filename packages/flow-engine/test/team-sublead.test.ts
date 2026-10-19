import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { next, parseFlow, resolveParams, teamState, type RunContext, type Step, type TaskState } from "../src/index.ts";

const flow = parseFlow(readFileSync(fileURLToPath(new URL("../../../flows/team.yaml", import.meta.url)), "utf8"));

type Plan = { summary?: string; done?: boolean; members?: Record<string, unknown>[] };
const plan = (p: Plan) => ({ summary: "```navarch-team\n" + JSON.stringify({ summary: "turn summary", done: false, members: [], ...p }) + "\n```" });
const member = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: `Do ${key}`, brief: `Brief ${key}`, profile: "implementer", ...extra });
const sublead = (key: string, extra: Record<string, unknown> = {}) => member(key, { profile: "sublead", ...extra });

function ctx(tasks: TaskState[], params: Record<string, number | string | boolean> = {}): RunContext {
  return { params: { ...resolveParams(flow), ...params }, project: { autonomy_level: 3, work_item: false }, tasks, skipped: [] };
}
const task = (node_id: string, outputs: Record<string, unknown> = {}, iteration = 1, status: TaskState["status"] = "succeeded"): TaskState => ({ node_id, iteration, status, outputs });

/** What the Orchestrator does: start every step the engine returns until it says something else. */
function startAll(tasks: TaskState[], params: Record<string, number | string | boolean> = {}) {
  const started: Extract<Step, { kind: "start" }>["start"][] = [];
  for (;;) {
    const step = next(flow, ctx(tasks, params));
    if (step.kind !== "start") return { started, step };
    started.push(step.start);
    tasks.push(task(step.start.node.id, {}, step.start.iteration, "ready"));
  }
}
const ids = (r: { started: { node: { id: string }; iteration: number }[] }) => r.started.map((s) => `${s.node.id}#${s.iteration}`);
const finish = (tasks: TaskState[], id: string, outputs: Record<string, unknown> = {}, status: TaskState["status"] = "succeeded", iteration = 1) => {
  const t = tasks.find((x) => x.node_id === id && x.iteration === iteration)!;
  t.status = status;
  t.outputs = outputs;
};

describe("two-level teams (ADR 0058)", () => {
  it("starts a sub-lead's own lead turn in the sub-lead's worktree, while an ordinary member runs beside it", () => {
    const tasks = [task("team.lead", plan({ members: [sublead("api"), member("docs")] }))];
    const r = startAll(tasks);
    expect(ids(r)).toEqual(["team.api.lead#1", "team.docs#1"]);
    expect(r.started[0]).toMatchObject({
      node: { profile: "sublead" },
      team: { node_id: "team", role: "lead", sub: "api", own_worktree: true },
      inputs: { assignment: "Do api\nBrief api" },
    });
    expect(r.started[1]!.team).toEqual({ node_id: "team", role: "member", key: "docs", own_worktree: true });
    expect(teamState("team", tasks, true).members.map((m) => `${m.key}:${m.status}`)).toEqual(["api:running", "docs:ready"]);
  });

  it("runs the sub-lead's members in worktrees of their own and merges them into the sub-lead's, then closes the sub-team", () => {
    const tasks = [task("team.lead", plan({ members: [sublead("api")] }))];
    startAll(tasks);
    finish(tasks, "team.api.lead", plan({ members: [member("db"), member("routes", { profile: "backend" })] }));
    const r = startAll(tasks);
    expect(ids(r)).toEqual(["team.api.db#1", "team.api.routes#1"]);
    expect(r.started[0]!.team).toEqual({ node_id: "team", role: "member", key: "db", own_worktree: true, sub: "api" });
    finish(tasks, "team.api.db", { summary: "db done" });
    finish(tasks, "team.api.routes", { summary: "routes done" });
    const merge = startAll(tasks);
    expect(ids(merge)).toEqual(["team.api.db.integrate#1"]);
    expect(merge.started[0]!.team).toEqual({ node_id: "team", role: "integrate", key: "db", sub: "api" });
    finish(tasks, "team.api.db.integrate", { merged: true });
    expect(ids(startAll(tasks))).toEqual(["team.api.routes.integrate#1"]);
    finish(tasks, "team.api.routes.integrate", { merged: true });
    // The sub-team's checks run in the sub-lead's worktree.
    const verify = startAll(tasks);
    expect(ids(verify)).toEqual(["team.api.verify#1"]);
    expect(verify.started[0]!.team).toMatchObject({ role: "verify", sub: "api" });
    finish(tasks, "team.api.verify", { passed: true });
    // The sub-lead's next turn says it is done; the sub-team closes with a task the parent reads as the member.
    const turn2 = startAll(tasks);
    expect(ids(turn2)).toEqual(["team.api.lead#2"]);
    finish(tasks, "team.api.lead", plan({ done: true, summary: "the API is ready" }), "succeeded", 2);
    expect(ids(startAll(tasks))).toEqual(["team.api.verify#2"]);
    finish(tasks, "team.api.verify", { passed: true }, "succeeded", 2);
    const close = startAll(tasks);
    expect(ids(close)).toEqual(["team.api#1"]);
    expect(close.started[0]).toMatchObject({ node: { type: "action", uses: "team.subteam" }, team: { node_id: "team", role: "member", key: "api" }, inputs: { team_summary: "the API is ready" } });
    finish(tasks, "team.api", { summary: "the API is ready" });
    // The sub-lead's branch is merged into the main worktree like an editing member.
    const integrate = startAll(tasks);
    expect(ids(integrate)).toEqual(["team.api.integrate#1"]);
    expect(integrate.started[0]!.team).toEqual({ node_id: "team", role: "integrate", key: "api" });
  });

  it("a dependant of a sub-lead waits for its merge", () => {
    const tasks = [task("team.lead", plan({ members: [sublead("api"), member("ui", { depends_on: ["api"] })] }))];
    expect(ids(startAll(tasks))).toEqual(["team.api.lead#1"]);
    finish(tasks, "team.api.lead", plan({ done: true }));
    expect(ids(startAll(tasks))).toEqual(["team.api.verify#1"]);
    finish(tasks, "team.api.verify", { passed: true });
    expect(ids(startAll(tasks))).toEqual(["team.api#1"]);
    finish(tasks, "team.api", { summary: "done" });
    expect(ids(startAll(tasks))).toEqual(["team.api.integrate#1"]);
    finish(tasks, "team.api.integrate", { merged: true });
    expect(ids(startAll(tasks))).toEqual(["team.ui#1"]);
  });

  it("closes a sub-team that ran out of turns as failed, and its dependants are skipped", () => {
    const tasks = [task("team.lead", plan({ members: [sublead("api"), member("ui", { depends_on: ["api"] })] }))];
    startAll(tasks);
    for (let turn = 1; turn <= 4; turn++) {
      finish(tasks, "team.api.lead", plan({ summary: "still working" }), "succeeded", turn);
      const r = startAll(tasks);
      if (turn < 4) {
        expect(ids(r)).toEqual([`team.api.verify#${turn}`]);
        finish(tasks, "team.api.verify", { passed: true }, "succeeded", turn);
        expect(ids(startAll(tasks))).toEqual([`team.api.lead#${turn + 1}`]);
      } else {
        expect(ids(r)).toEqual(["team.api.verify#4"]);
        finish(tasks, "team.api.verify", { passed: true }, "succeeded", 4);
      }
    }
    const close = startAll(tasks);
    expect(close.started[0]).toMatchObject({ node: { id: "team.api" }, inputs: { failed: expect.stringContaining("max_turns") } });
    finish(tasks, "team.api", {}, "failed");
    expect(teamState("team", tasks, true).members.find((m) => m.key === "ui")!.skipped).toContain("api");
  });

  it("refuses sub-leads inside a sub-lead's team, reserved keys, too many sub-leads, and a team that is not parallel", () => {
    const nested = [task("team.lead", plan({ members: [sublead("api")] }))];
    startAll(nested);
    finish(nested, "team.api.lead", plan({ members: [sublead("deeper")] }));
    const r = startAll(nested);
    expect(r.started[0]!.inputs.reason).toContain("cannot have sub-leads");

    const reserved = [task("team.lead", plan({ members: [member("verify")] }))];
    expect(startAll(reserved).started[0]!.inputs.reason).toContain("reserved");

    const many = [task("team.lead", plan({ members: ["a", "b", "c", "d"].map((k) => sublead(k)) }))];
    expect(startAll(many).step).toMatchObject({ kind: "fail", reason: expect.stringContaining("4 sub-leads") });

    const serial = [task("team.lead", plan({ members: [sublead("api")] }))];
    expect(startAll(serial, { parallel: false }).step).toMatchObject({ kind: "fail", reason: expect.stringContaining("parallel") });
  });
});
