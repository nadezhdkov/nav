import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFlow, progress, type RunContext, type TaskState } from "../src/index.ts";

const flow = (name: string) => parseFlow(readFileSync(fileURLToPath(new URL(`../../../flows/${name}.yaml`, import.meta.url)), "utf8"));
const t = (node_id: string, status: TaskState["status"], iteration = 1, outputs: Record<string, unknown> | null = null): TaskState => ({ node_id, iteration, status, outputs });
const ctx = (tasks: TaskState[], skipped: string[] = []): RunContext => ({ params: { max_fix_iterations: 3 }, project: { autonomy_level: 2 }, tasks, skipped });

describe("step progress (slice 10)", () => {
  const fix = flow("fix-issue");

  it("counts every node of the Flow but the trigger, loop bodies node by node", () => {
    expect(progress(fix, ctx([]))).toEqual({ done: 0, total: 7 });
    expect(progress(flow("task"), ctx([])).total).toBe(2);
  });

  it("counts finished and skipped nodes in chain order", () => {
    expect(progress(fix, ctx([t("triage", "succeeded"), t("plan", "succeeded"), t("approve_plan", "waiting_approval")]))).toEqual({ done: 2, total: 7 });
    expect(progress(fix, ctx([t("triage", "succeeded"), t("plan", "succeeded"), t("implement", "running")], ["approve_plan"]))).toEqual({ done: 3, total: 7 });
  });

  it("counts a fix loop once: only the current iteration's finished body nodes", () => {
    const first = [t("triage", "succeeded"), t("plan", "succeeded"), t("approve_plan", "succeeded")];
    const failedOnce = [...first, t("implement", "succeeded"), t("verify", "succeeded", 1, { passed: false })];
    expect(progress(fix, ctx(failedOnce)).done).toBe(4);
    expect(progress(fix, ctx([...failedOnce, t("implement", "running", 2)])).done).toBe(3);
    const passed = [...failedOnce, t("implement", "succeeded", 2), t("verify", "succeeded", 2, { passed: true })];
    expect(progress(fix, ctx(passed))).toEqual({ done: 5, total: 7 });
    expect(progress(fix, ctx([...passed, t("review", "succeeded"), t("open_pr", "succeeded")]))).toEqual({ done: 7, total: 7 });
  });

  it("stops at a failed node", () => {
    expect(progress(fix, ctx([t("triage", "succeeded"), t("plan", "failed"), t("review", "succeeded")])).done).toBe(1);
  });

  it("counts a team node once, when the team is done", () => {
    const team = flow("team");
    expect(progress(team, ctx([])).total).toBe(3);
    expect(progress(team, ctx([t("team.lead", "running")])).done).toBe(0);
    expect(progress(team, ctx([t("team.lead", "running"), t("review", "succeeded")], ["team"])).done).toBe(2);
  });
});
