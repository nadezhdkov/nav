import type { ApprovalView, RunView } from "@navarch/contracts";
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
});
