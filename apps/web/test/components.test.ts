import type { ApprovalView, CompetitorView, RunView } from "@navarch/contracts";
import { flushPromises, mount, RouterLinkStub } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../src/i18n.ts";

const api = vi.hoisted(() => ({
  runs: vi.fn(),
  approvals: vi.fn(),
  decide: vi.fn(),
  health: vi.fn(),
}));
vi.mock("../src/api/client.ts", async (orig) => ({ ...(await orig<object>()), api }));

const { default: RunsView } = await import("../src/views/RunsView.vue");
const { default: ApprovalsView } = await import("../src/views/ApprovalsView.vue");
const { useApprovalsStore, useRunsStore } = await import("../src/stores/runs.ts");

const run: RunView = {
  id: "run_01ABC",
  name: "brave-frigate",
  status: "awaiting_approval",
  repo_path: "/home/me/src/widget",
  base_commit: "abc123",
  prompt: "Add a CONTRIBUTING.md\nwith sections",
  budget: 2,
  cost_total: 0.4,
  plan_cost: 0,
  created_at: "2026-10-15T00:00:00Z",
  updated_at: "2026-10-15T00:00:00Z",
  ended_at: null,
  work_item: null,
  pr_url: null,
  flow: "task",
  autonomy_level: 2,
};

const approval: ApprovalView = {
  id: "apr_1",
  run_id: run.id,
  task_id: "task_1",
  action: "pr.create",
  resource: "task_1",
  reason: "autonomy level 2 asks before opening a PR",
  summary: "Open a draft PR from navarch/run_01ABC/task",
  status: "pending",
  decision_reason: null,
  choices: [],
  choice: null,
  created_at: "2026-10-15T00:00:00Z",
  decided_at: null,
};

const global = { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } };

beforeEach(() => {
  setActivePinia(createPinia());
  for (const fn of Object.values(api)) fn.mockReset();
});

describe("RunsView", () => {
  it("shows each run's status as icon plus text, its title, flow and cost", async () => {
    api.runs.mockResolvedValue([run]);
    await useRunsStore().load();
    const wrapper = mount(RunsView, { global });
    const row = wrapper.find("tbody tr");
    expect(row.text()).toContain("Awaiting approval");
    expect(row.find("svg").exists()).toBe(true);
    expect(row.text()).toContain("Add a CONTRIBUTING.md");
    expect(row.text()).not.toContain("with sections");
    expect(row.text()).toContain("$0.400 / $2.00");
    expect(wrapper.findComponent(RouterLinkStub).props("to")).toBe("/runs/run_01ABC");
  });

  it("explains how to start a run when there are none", async () => {
    api.runs.mockResolvedValue([]);
    await useRunsStore().load();
    expect(mount(RunsView, { global }).text()).toContain("navarch run");
  });
});

describe("ApprovalsView", () => {
  it("shows what will happen, why and the run's cost, then approves with the reason", async () => {
    api.runs.mockResolvedValue([run]);
    api.approvals.mockResolvedValueOnce([approval]).mockResolvedValueOnce([{ ...approval, status: "approved" }]);
    api.decide.mockResolvedValue({});
    await useRunsStore().load();
    await useApprovalsStore().load();
    const wrapper = mount(ApprovalsView, { global });
    const card = wrapper.find("article");
    expect(card.text()).toContain("Open a draft PR from navarch/run_01ABC/task");
    expect(card.text()).toContain("autonomy level 2 asks before opening a PR");
    expect(card.text()).toContain("$0.400 / $2.00");

    await card.find("input").setValue("plan looks right");
    await card.findAll("button").find((b) => b.text() === "Approve")!.trigger("click");
    await flushPromises();
    expect(api.decide).toHaveBeenCalledWith("apr_1", "approve", "plan looks right");
    expect(wrapper.find("article").exists()).toBe(false);
    expect(wrapper.text()).toContain("Approved");
  });

  it("offers an approval's choices with the default picked, and approves another one (ADR 0031)", async () => {
    const pick = { ...approval, action: "flow.approval", summary: "1. c2 (8/10): smaller", choices: ["c2", "c1"] };
    api.runs.mockResolvedValue([run]);
    api.approvals.mockResolvedValueOnce([pick]).mockResolvedValueOnce([{ ...pick, status: "approved", choice: "c1" }]);
    api.decide.mockResolvedValue({});
    await useRunsStore().load();
    await useApprovalsStore().load();
    const wrapper = mount(ApprovalsView, { global });
    const radios = wrapper.findAll("input[type=radio]");
    expect(radios.map((r) => (r.element as HTMLInputElement).value)).toEqual(["c2", "c1"]);
    expect((radios[0]!.element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.find("fieldset").text()).toContain("suggested");
    expect(wrapper.findAll("button").map((b) => b.text())).toContain("Approve c2");
    await radios[1]!.setValue(true);
    await wrapper.findAll("button").find((b) => b.text() === "Approve c1")!.trigger("click");
    await flushPromises();
    expect(api.decide).toHaveBeenCalledWith("apr_1", "approve", undefined, "c1");
    expect(wrapper.text()).toContain("picked c1");
  });
});

describe("CompetePanel", () => {
  it("lists competitors best first with their agent, rank and why the others are out", async () => {
    const { default: CompetePanel } = await import("../src/components/CompetePanel.vue");
    const competitor = (key: string, over: Partial<CompetitorView>): CompetitorView => ({ key, task_id: `t_${key}`, status: "succeeded", state: "finalist", reason: null, adapter: "claude-code", model: null, iterations: 1, branch: null, summary: null, rank: null, score: null, judge_reason: null, ...over });
    const wrapper = mount(CompetePanel, {
      global,
      props: {
        compete: {
          node_id: "compete",
          competitors: [
            competitor("c1", { rank: 2, score: 6, judge_reason: "works too" }),
            competitor("c2", { rank: 1, score: 8, judge_reason: "smaller", adapter: "codex" }),
            competitor("c3", { state: "out", status: "failed", reason: "the agent failed" }),
          ],
          judge_task_id: "t_j",
          judge_summary: "c2 wins on size.",
          judge_error: null,
          winner: "c2",
          chosen_by: "judge",
          adopted: true,
        },
      },
    });
    const rows = wrapper.findAll("li").map((li) => li.text());
    expect(rows[0]).toContain("Winner");
    expect(rows[0]).toContain("c2");
    expect(rows[0]).toContain("#1 · 8/10");
    expect(rows[0]).toContain("codex");
    expect(rows[1]).toContain("Finalist");
    expect(rows[2]).toContain("Out");
    expect(rows[2]).toContain("the agent failed");
    expect(wrapper.text()).toContain("Ranked first by the judge.");
  });
});
