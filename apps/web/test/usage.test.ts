import type { BudgetView, ModelMetricsView, UsageView } from "@navarch/contracts";
import { flushPromises, mount, RouterLinkStub } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../src/i18n.ts";
import { budgetPercent, sortModels, visibleBudgets } from "../src/lib/usage.ts";

const api = vi.hoisted(() => ({ usage: vi.fn(), setBudget: vi.fn() }));
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

const global = { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } };

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = "en";
  mode.client = "web";
  api.usage.mockReset().mockResolvedValue(view);
  api.setBudget.mockReset().mockResolvedValue([]);
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

describe("Usage view", () => {
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
