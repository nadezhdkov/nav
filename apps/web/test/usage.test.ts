import type { BudgetView, MetricsView, ModelMetricsView, UsageView } from "@navarch/contracts";
import { flushPromises, mount, RouterLinkStub } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../src/i18n.ts";
import { dayBars, meetsTarget, niceCeil, shareBars } from "../src/lib/metrics.ts";
import { budgetPercent, sortModels, visibleBudgets } from "../src/lib/usage.ts";

const api = vi.hoisted(() => ({ usage: vi.fn(), setBudget: vi.fn(), metrics: vi.fn() }));
const mode = vi.hoisted(() => ({ client: "web" as "web" | "mobile" }));
vi.mock("../src/api/client.ts", async (orig) => ({ ...(await orig<object>()), api, client: () => mode.client }));

const { default: UsagePage } = await import("../src/views/UsageView.vue");

function budget(over: Partial<BudgetView>): BudgetView {
  return { scope: "global_monthly", target: null, label: "global", period: "2026-10", limit: 100, source: "config", used: 85, plan_equivalent: 12, ratio: 0.85, state: "warning", ...over };
}

function model(id: string, over: Partial<ModelMetricsView> = {}): ModelMetricsView {
  return {
    id,
    adapter: id,
    model: null,
    billing: "plan",
    profile: null,
    tasks: 4,
    succeeded: 3,
    success_rate: 0.75,
    error_rate_24h: null,
    rate_limited: 0,
    tokens_in: 120_000,
    tokens_out: 8_000,
    cached_tokens: 0,
    median_tokens_per_success: 40_000,
    cost: 0,
    plan_cost: 2.4,
    median_cost_per_success: 0.6,
    p50_duration_ms: 90_000,
    ...over,
  };
}

const view: UsageView = {
  generated_at: "2026-10-15T12:00:00Z",
  window_days: 30,
  today: { cost: 0.42, plan_cost: 3.1, tokens: 52_000 },
  month: { cost: 85, plan_cost: 40, tokens: 2_000_000 },
  budgets: [
    budget({}),
    budget({ scope: "project_daily", target: "prj_1", label: "acme", period: "2026-10-15", limit: null, ratio: null, state: "ok", used: 0.4, plan_equivalent: 0 }),
    budget({ scope: "run", target: "run_1", label: "Fix the parser", period: "run_1", limit: 2, source: "run", used: 2.2, ratio: 1.1, state: "exceeded" }),
    budget({ scope: "run", target: "run_2", label: "Quiet run", period: "run_2", limit: 2, source: "run", used: 0.1, ratio: 0.05, state: "ok" }),
  ],
  models: [model("claude-code"), model("qwen", { billing: "metered", tasks: 9, cost: 0.9, plan_cost: 0, median_cost_per_success: null })],
  quotas: [],
};

const metrics: MetricsView = {
  generated_at: "2026-10-16T12:00:00Z",
  window_days: 30,
  cost: {
    total: { cost: 0.5, plan_cost: 4, tokens: 90_000 },
    days: [
      { day: "2026-10-15", cost: 0, plan_cost: 0, tokens: 0 },
      { day: "2026-10-16", cost: 0.5, plan_cost: 4, tokens: 90_000 },
    ],
    projects: [
      { kind: "project", project_id: "prj_1", label: "acme", runs: 3, cost: 0.4, plan_cost: 4, tokens: 80_000 },
      { kind: "outside", project_id: null, label: "outside runs", runs: 0, cost: 0.1, plan_cost: 0, tokens: 10_000 },
    ],
    profiles: [{ profile: "implementer", tasks: 3, cost: 0.4, plan_cost: 4, tokens: 80_000 }],
    models: [{ model: "sonnet", calls: 12, cost: 0.4, plan_cost: 4, tokens: 80_000 }],
  },
  quality: {
    profiles: [{ profile: "implementer", tasks: 5, succeeded: 4, success_rate: 0.8, rate_limited: 1 }],
    models: [model("claude-code")],
    pull_requests: {
      opened: 4,
      open: 1,
      merged: 1,
      closed: 2,
      gone: 0,
      acceptance_rate: 0.333,
      accepted_as_is: 1,
      rework: 0,
      rework_rate: 0,
      cost_per_merged: 1.2,
      recent: [
        { run_id: "run_1", run_name: "brave-frigate", repo: "o/acme", number: 12, url: "https://github.com/o/acme/pull/12", state: "merged", opened_at: "2026-10-16T10:00:00Z", closed_at: "2026-10-16T11:00:00Z", commits_after: 0, cost: 0, plan_cost: 1.2 },
      ],
    },
  },
  knowledge: {
    target_reduction: 0.3,
    min_attempts: 3,
    context: { attempts: 0, median_est_tokens: null },
    profiles: [],
    overall: { with: { attempts: 0, succeeded: 0, success_rate: null, median_input_tokens: null }, without: { attempts: 0, succeeded: 0, success_rate: null, median_input_tokens: null }, reduction: null },
    pull_requests: { with: { closed: 0, merged: 0, acceptance_rate: null }, without: { closed: 0, merged: 0, acceptance_rate: null } },
    verdict: "insufficient",
  },
};

const global = { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } };

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = "en";
  mode.client = "web";
  api.usage.mockReset().mockResolvedValue(view);
  api.setBudget.mockReset().mockResolvedValue([]);
  api.metrics.mockReset().mockResolvedValue(metrics);
  localStorage.clear();
});

describe("usage helpers (ADR 0023)", () => {
  it("sorts models with missing values last in both directions", () => {
    const models = [model("a", { median_cost_per_success: null }), model("b", { median_cost_per_success: 0.2 }), model("c", { median_cost_per_success: 0.1 })];
    expect(sortModels(models, "median_cost_per_success", "asc").map((m) => m.id)).toEqual(["c", "b", "a"]);
    expect(sortModels(models, "median_cost_per_success", "desc").map((m) => m.id)).toEqual(["b", "c", "a"]);
    expect(sortModels(models, "id", "desc").map((m) => m.id)).toEqual(["c", "b", "a"]);
  });

  it("caps bars at 100 % and shows runs only near or over their budget", () => {
    expect(budgetPercent(view.budgets[2]!)).toBe(100);
    expect(budgetPercent(view.budgets[1]!)).toBeNull();
    expect(visibleBudgets(view.budgets).map((b) => b.target)).toEqual([null, "prj_1", "run_1"]);
  });
});

describe("metrics helpers (ADR 0037)", () => {
  it("rounds the chart's top to 1, 2 or 5 × 10ⁿ and scales bars to it", () => {
    expect([niceCeil(0), niceCeil(0.03), niceCeil(0.3), niceCeil(4.5), niceCeil(12)]).toEqual([1, 0.05, 0.5, 5, 20]);
    const { top, bars } = dayBars(metrics.cost.days);
    expect(top).toBe(5);
    expect(bars[1]).toMatchObject({ billedPct: 10, planPct: 80 });
    expect(shareBars(metrics.cost.projects).map((r) => Math.round(r.billedPct + r.planPct))).toEqual([100, 2]);
  });

  it("compares rates with the §17 targets", () => {
    expect([meetsTarget("acceptance", 0.5), meetsTarget("acceptance", 0.49), meetsTarget("rework", 0.25), meetsTarget("rework", null)]).toEqual([true, false, false, null]);
  });
});

describe("Usage view", () => {
  it("loads the cost panel only when its tab opens, and remembers the tab", async () => {
    const wrapper = mount(UsagePage, { global });
    await flushPromises();
    expect(api.metrics).not.toHaveBeenCalled();
    await wrapper.find("#usage-tab-cost").trigger("click");
    await flushPromises();
    expect(api.metrics).toHaveBeenCalledWith(30);
    const text = wrapper.text();
    expect(text).toContain("Spend per day");
    expect(text).toContain("Outside runs (Inbox triage)");
    expect(wrapper.findAll('[role="listitem"]').map((b) => b.attributes("aria-label"))).toEqual([expect.stringContaining("$0.000 billed"), expect.stringContaining("$0.500 billed, $4.00 plan-equivalent")]);
    expect(localStorage.getItem("navarch.usage.tab")).toBe("cost");

    await wrapper.findAll('[role="group"] button').find((b) => b.text() === "90 days")!.trigger("click");
    await flushPromises();
    expect(api.metrics).toHaveBeenLastCalledWith(90);
  });

  it("shows PR rates against their targets in text, and success per profile", async () => {
    localStorage.setItem("navarch.usage.tab", "quality");
    const wrapper = mount(UsagePage, { global });
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain("33%");
    expect(text).toContain("1 merged of 3 closed");
    expect(text).toContain("Off target · target at least 50%");
    expect(text).toContain("On target · target below 25%");
    expect(text).toContain("$1.20");
    expect(text).toContain("1 rate-limited, not counted");
    expect(wrapper.find('a[href="https://github.com/o/acme/pull/12"]').exists()).toBe(true);
    expect(text).toContain("Merged");
  });

  it("moves between tabs with the arrow keys", async () => {
    const wrapper = mount(UsagePage, { global, attachTo: document.body });
    await flushPromises();
    await wrapper.find('[role="tablist"]').trigger("keydown", { key: "ArrowLeft" });
    await flushPromises();
    expect(wrapper.find("#usage-tab-quality").attributes("aria-selected")).toBe("true");
    wrapper.unmount();
  });

  it("shows spend apart from plan use, and budget states in text with meters", async () => {
    const wrapper = mount(UsagePage, { global });
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain("$0.420 billed");
    expect(text).toContain("$3.10 plan-equivalent");
    expect(text).toContain("Everything, 2026-10");
    expect(text).toContain("Near the limit");
    expect(text).toContain("$85.00 of $100.00 · 85%");
    expect(text).toContain("Used up: new agents wait for approval");
    expect(text).toContain("acme, today");
    expect(text).not.toContain("Quiet run");
    const meters = wrapper.findAll('[role="meter"]');
    expect(meters.map((m) => m.attributes("aria-valuenow"))).toEqual(["85", "100"]);
    expect(wrapper.findAll("tbody tr").map((r) => r.find("th").text())).toEqual([expect.stringContaining("qwen"), expect.stringContaining("claude-code")]);
  });

  it("changes a limit after showing the current one and what it affects", async () => {
    const wrapper = mount(UsagePage, { global });
    await flushPromises();
    await wrapper.findAll("button").find((b) => b.attributes("aria-label") === "Change the limit of Everything, 2026-10")!.trigger("click");
    const form = wrapper.find("form");
    expect(form.text()).toContain("Current limit: $100.00");
    expect(form.text()).toContain("Raising a limit releases the tasks waiting on it.");
    await form.find('input[type="number"]').setValue("150");
    await form.trigger("submit");
    await flushPromises();
    expect(api.setBudget).toHaveBeenCalledWith({ scope: "global_monthly", usd: 150 });
    expect(wrapper.text()).toContain("Limit saved.");
  });

  it("offers no budget changes on a paired phone", async () => {
    mode.client = "mobile";
    const wrapper = mount(UsagePage, { global });
    await flushPromises();
    expect(wrapper.text()).toContain("Budgets can be changed only from the PC.");
    expect(wrapper.findAll("button").some((b) => b.text().includes("Change"))).toBe(false);
  });
});
