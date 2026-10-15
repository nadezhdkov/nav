import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { next, parseFlow, renderInputs, resolveParams, type RunContext, type Step, type TaskState } from "../src/index.ts";

const flow = parseFlow(readFileSync(fileURLToPath(new URL("../../../flows/team.yaml", import.meta.url)), "utf8"));

type Plan = { summary?: string; done?: boolean; question?: string | null; members?: Record<string, unknown>[] };
const plan = (p: Plan) => ({ summary: "```navarch-team\n" + JSON.stringify({ summary: "turn summary", done: false, members: [], ...p }) + "\n```" });
const member = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: `Do ${key}`, brief: `Brief ${key}`, profile: "implementer", ...extra });

function ctx(tasks: TaskState[], project: Record<string, unknown> = { autonomy_level: 3 }, params: Record<string, number | string | boolean> = {}): RunContext {
  return { params: { ...resolveParams(flow), ...params }, project: { work_item: false, ...project }, tasks, skipped: [] };
}
const done = (node_id: string, outputs: Record<string, unknown>, iteration = 1, status: TaskState["status"] = "succeeded"): TaskState => ({ node_id, iteration, status, outputs });
const started = (step: Step) => {
  if (step.kind !== "start") throw new Error(`expected start, got ${JSON.stringify(step)}`);
  return step.start;
};

describe("team node (ADR 0022)", () => {
  it("starts with the lead's first turn", () => {
    const s = started(next(flow, ctx([])));
    expect(s).toMatchObject({ node: { id: "team.lead", type: "agent", profile: "lead" }, iteration: 1, stage: "planning", team: { node_id: "team", role: "lead" } });
    expect(renderInputs(s.inputs).turn).toBe("1 of 8");
  });

  it("runs members in dependency order, verifies, then gives the lead the results", () => {
    const tasks = [done("team.lead", plan({ members: [member("ui", { depends_on: [] }), member("api", { prefer: "codex" }), member("wire", { depends_on: ["ui"] }), member("docs", { depends_on: ["api"] })] }))];
    const first = started(next(flow, ctx(tasks)));
    expect(first).toMatchObject({ node: { id: "team.ui", profile: "implementer" }, stage: "executing", team: { role: "member", key: "ui" } });
    expect(renderInputs(first.inputs).brief).toBe("Brief ui");
    tasks.push(done("team.ui", { summary: "ui done" }));

    expect(started(next(flow, ctx(tasks)))).toMatchObject({ node: { id: "team.api" }, prefer: "codex" });
    tasks.push(done("team.api", { summary: "api broke" }, 1, "failed"));

    const wire = started(next(flow, ctx(tasks)));
    expect(wire.node.id).toBe("team.wire");
    expect(renderInputs(wire.inputs).depends_on).toContain("ui done");
    tasks.push(done("team.wire", { summary: "wired" }));

    expect(started(next(flow, ctx(tasks)))).toMatchObject({ node: { id: "team.verify", type: "action", uses: "verification.run" }, iteration: 1, stage: "verifying", team: { role: "verify" } });
    tasks.push(done("team.verify", { passed: false, blocking_failures: ["test: exit 1"] }));

    const lead2 = started(next(flow, ctx(tasks)));
    expect(lead2).toMatchObject({ node: { id: "team.lead" }, iteration: 2, stage: "executing" });
    const inputs = renderInputs(lead2.inputs);
    expect(inputs.team).toMatch(/api.*failed/);
    expect(inputs.team).toContain("wired");
    expect(inputs.team).toMatch(/docs.*not started: api failed/);
    expect(inputs.checks).toContain("test: exit 1");
    expect(inputs.turn).toBe("2 of 8");
  });

  it("caps each member's summary in the lead's prompt", () => {
    const tasks = [done("team.lead", plan({ members: [member("api")] })), done("team.api", { summary: "x".repeat(5_000) }), done("team.verify", { passed: true })];
    const team = renderInputs(started(next(flow, ctx(tasks))).inputs).team!;
    expect(team.length).toBeLessThan(2_200);
    expect(team).toContain("[cut: 3000 more characters in the member's output]");
  });

  it("finishes when the lead is done and the checks pass, then reviews; no PR without an issue", () => {
    const tasks = [
      done("team.lead", plan({ members: [member("api")] })),
      done("team.api", { summary: "ok" }),
      done("team.verify", { passed: true, blocking_failures: [] }),
      done("team.lead", plan({ summary: "All finished", done: true }), 2),
      done("team.verify", { passed: true, blocking_failures: [] }, 2),
    ];
    const review = started(next(flow, ctx(tasks)));
    expect(review.node.id).toBe("review");
    expect(renderInputs(review.inputs).implementation).toBe("All finished");
    tasks.push(done("review", { summary: "approve" }));
    expect(next(flow, ctx(tasks))).toEqual({ kind: "skip", nodeId: "open_pr", reason: expect.any(String) });
  });

  it("opens a PR for an issue run", () => {
    const tasks = [done("team.lead", plan({ done: true })), done("team.verify", { passed: true }), done("review", { summary: "approve" })];
    expect(started(next(flow, ctx(tasks, { autonomy_level: 3, work_item: true }))).node.id).toBe("open_pr");
  });

  it("starts another turn when the lead says done but the checks fail", () => {
    const tasks = [done("team.lead", plan({ done: true })), done("team.verify", { passed: false, blocking_failures: ["lint"] })];
    const s = started(next(flow, ctx(tasks)));
    expect(s).toMatchObject({ node: { id: "team.lead" }, iteration: 2 });
    expect(renderInputs(s.inputs).reason).toMatch(/checks still fail/);
  });

  it("gives an invalid plan back to the lead once, and fails on the second", () => {
    const tasks = [done("team.lead", { summary: "no block here" })];
    const s = started(next(flow, ctx(tasks)));
    expect(renderInputs(s.inputs).reason).toMatch(/no ```navarch-team block/);
    tasks.push(done("team.lead", { summary: "still none" }, 2));
    expect(next(flow, ctx(tasks))).toMatchObject({ kind: "fail", reason: expect.stringMatching(/two invalid team plans/) });
  });

  it("fails after max_turns", () => {
    const tasks = [done("team.lead", plan({})), done("team.verify", { passed: true }), done("team.lead", plan({}), 2), done("team.verify", { passed: true }, 2)];
    expect(next(flow, ctx(tasks, undefined, { max_turns: 2 }))).toMatchObject({ kind: "fail", reason: expect.stringMatching(/2 turn/) });
  });

  it("fails when the team would exceed max_members", () => {
    const tasks = [done("team.lead", plan({ members: [member("a"), member("b"), member("c")] }))];
    expect(next(flow, ctx(tasks, undefined, { max_members: 2 }))).toMatchObject({ kind: "fail", reason: expect.stringMatching(/max_members/) });
  });

  it("blocks the next turn on a question until the user answers", () => {
    const tasks = [done("team.lead", plan({ question: "Postgres or SQLite?" }))];
    const s = started(next(flow, ctx(tasks)));
    expect(s).toMatchObject({ node: { id: "team.lead" }, iteration: 2, blocked: "question" });
    expect(renderInputs(s.inputs).reason).toContain("Postgres or SQLite?");
  });

  it("asks a human to approve the first plan with members below level 3", () => {
    const tasks = [done("team.lead", plan({ members: [member("api")] }))];
    const s = started(next(flow, ctx(tasks, { autonomy_level: 2 })));
    expect(s).toMatchObject({ node: { id: "team.approve_plan", type: "approval" }, stage: "awaiting_approval", team: { role: "approval" } });
    expect(s.show.map((x) => x.value).join("\n")).toContain("Do api");
    tasks.push(done("team.approve_plan", {}));
    expect(started(next(flow, ctx(tasks, { autonomy_level: 2 }))).node.id).toBe("team.api");
  });

  it("waits while a team task is in progress and fails when the lead failed", () => {
    expect(next(flow, ctx([done("team.lead", {}, 1, "running")]))).toEqual({ kind: "wait" });
    expect(next(flow, ctx([done("team.lead", {}, 1, "failed")]))).toMatchObject({ kind: "fail" });
    expect(next(flow, ctx([done("team.lead", plan({ members: [member("a")] })), done("team.a", {}, 1, "blocked")]))).toEqual({ kind: "wait" });
  });
});
