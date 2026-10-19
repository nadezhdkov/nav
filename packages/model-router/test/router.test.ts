import { describe, expect, it } from "vitest";
import { route, type RouteRequest, type RouterConfig } from "../src/index.ts";

const config: RouterConfig = {
  models: {
    "claude-code": { adapter: "claude-code", provider: "anthropic", status: "active" },
    copilot: { adapter: "copilot", provider: "github", status: "active" },
    codex: { adapter: "codex", provider: "openai", status: "disabled" },
    qwen: { adapter: "native", model: "ollama/qwen2.5:7b", provider: "ollama", status: "active" },
  },
  tiers: { fast: ["copilot", "claude-code"], standard: ["claude-code", "copilot"], expert: ["claude-code", "copilot"] },
  profiles: { triager: "fast", planner: "expert", implementer: "standard", reviewer: "standard" },
  simple_max_complexity: 2,
  different_provider: ["reviewer"],
};

const req = (over: Partial<RouteRequest>): RouteRequest => ({
  profile: "implementer",
  iteration: 1,
  implementerProviders: [],
  adapters: new Set(["claude-code", "copilot", "codex", "native"]),
  exhausted: [],
  ...over,
});

describe("route", () => {
  it("uses the profile's tier when the run has no triage", () => {
    const d = route(config, req({}));
    expect(d).toMatchObject({ tier: "standard", chosen: { id: "claude-code", adapter: "claude-code" } });
    expect(d.reason).toBe("implementer needs standard; first usable in tier standard");
  });

  it("sends planner and implementer of a simple issue to the fast tier", () => {
    expect(route(config, req({ complexity: 2 })).chosen?.id).toBe("copilot");
    expect(route(config, req({ profile: "planner", complexity: 1 })).chosen?.id).toBe("copilot");
    expect(route(config, req({ complexity: 3 })).chosen?.id).toBe("claude-code");
    expect(route(config, req({ profile: "triager" })).chosen?.id).toBe("copilot");
  });

  it("escalates the implementer one tier after failed verification", () => {
    const d = route(config, req({ complexity: 1, iteration: 2 }));
    expect(d).toMatchObject({ tier: "standard", chosen: { id: "claude-code" } });
    expect(d.reason).toContain("escalated to standard after failed verification");
  });

  it("spreads competitors over providers, then over entries (ADR 0031)", () => {
    const wide: RouterConfig = {
      ...config,
      models: { ...config.models, "claude-haiku": { adapter: "claude-code", model: "haiku", provider: "anthropic", status: "active" } },
      tiers: { ...config.tiers, standard: ["claude-code", "claude-haiku", "copilot"] },
    };
    const other = route(wide, req({ spread: ["claude-code"] }));
    expect(other.chosen?.id).toBe("copilot");
    expect(other.reason).toBe("implementer needs standard; first usable in tier standard, a provider no other competitor uses (instead of claude-code)");
    const entry = route(wide, req({ spread: ["claude-code", "copilot"] }));
    expect(entry.chosen?.id).toBe("claude-haiku");
    expect(entry.reason).toContain("an agent no other competitor uses (no other provider usable)");
    const all = route(wide, req({ spread: ["claude-code", "claude-haiku", "copilot"] }));
    expect(all.chosen?.id).toBe("claude-code");
    expect(all.reason).toContain("every usable agent already competes");
    expect(route(wide, req({ prefer: "copilot", preferredBy: "its first iteration" })).reason).toBe("preferred by its first iteration (copilot)");
    // A held-back entry of another provider still comes after a fresh one already competing.
    const busy = route({ ...wide, quota_reserve: 0.9 }, req({ spread: ["claude-code"], quotaUse: [{ adapter: "copilot", window: "month", utilization: 0.95 }] }));
    expect(busy.chosen?.id).toBe("claude-haiku");
  });

  it("skips exhausted quotas, excluded entries and disabled adapters, with reasons", () => {
    const d = route(
      { ...config, tiers: { ...config.tiers, fast: ["codex", "copilot", "claude-code"] } },
      req({ profile: "triager", exhausted: [{ adapter: "copilot", resetsAt: "2026-11-01T00:00:00.000Z" }] }),
    );
    expect(d.chosen?.id).toBe("claude-code");
    expect(d.skipped).toEqual([
      { id: "codex", reason: "status disabled" },
      { id: "copilot", reason: "quota exhausted until 2026-11-01T00:00:00.000Z" },
    ]);
    expect(route(config, req({ exclude: ["claude-code"] })).chosen?.id).toBe("copilot");
    expect(route(config, req({ adapters: new Set(["copilot"]) })).skipped).toEqual([{ id: "claude-code", reason: "adapter claude-code not enabled" }]);
  });

  it("says an entry of another adapter is not usable here when the request takes one adapter only", () => {
    const d = route(config, req({ profile: "triager", onlyAdapter: "native" }));
    expect(d.chosen).toBeUndefined();
    expect(d.skipped).toEqual([
      { id: "copilot", reason: "copilot is not a native entry" },
      { id: "claude-code", reason: "claude-code is not a native entry" },
    ]);
    expect(route({ ...config, tiers: { ...config.tiers, fast: ["copilot", "qwen"] } }, req({ profile: "triager", onlyAdapter: "native" })).chosen?.id).toBe("qwen");
  });

  it("returns no choice when every candidate is unusable", () => {
    const d = route(config, req({ exclude: ["claude-code", "copilot"] }));
    expect(d.chosen).toBeUndefined();
    expect(d.reason).toContain("no usable candidate in tier standard");
  });

  it("puts the reviewer on a provider other than the implementer's", () => {
    const d = route(config, req({ profile: "reviewer", implementerProviders: ["anthropic"] }));
    expect(d.chosen?.id).toBe("copilot");
    expect(d.skipped).toEqual([{ id: "claude-code", reason: "same provider as the implementer" }]);
    expect(route(config, req({ profile: "reviewer", implementerProviders: ["github"] })).chosen?.id).toBe("claude-code");
  });

  it("falls back to the same provider for the reviewer when no other is usable, and says so", () => {
    const d = route(config, req({ profile: "reviewer", implementerProviders: ["anthropic"], exclude: ["copilot"] }));
    expect(d.chosen?.id).toBe("claude-code");
    expect(d.reason).toContain("no usable candidate from another provider");
  });

  it("skips entries whose adapter cannot run their model, and quotas scoped to a model prefix", () => {
    const free = {
      ...config,
      models: {
        ...config.models,
        "or-free": { adapter: "native", model: "openrouter/poolside/laguna-s-2.1:free", provider: "poolside", status: "active" as const },
        "zen-free": { adapter: "native", model: "opencode-zen/big-pickle", provider: "opencode", status: "active" as const },
      },
      tiers: { ...config.tiers, fast: ["or-free", "zen-free", "copilot"] },
    };
    const noZenKey = (e: { model?: string }) => (e.model?.startsWith("opencode-zen/") ? "no API key for provider opencode-zen" : undefined);
    const d = route(free, req({ profile: "triager", unavailable: noZenKey, exhausted: [{ adapter: "native", modelPrefix: "openrouter/", resetsAt: "2026-10-16T00:00:00.000Z" }] }));
    expect(d.chosen?.id).toBe("copilot");
    expect(d.skipped).toEqual([
      { id: "or-free", reason: "quota exhausted until 2026-10-16T00:00:00.000Z" },
      { id: "zen-free", reason: "no API key for provider opencode-zen" },
    ]);
    expect(route(free, req({ profile: "triager" })).chosen?.id).toBe("or-free");
  });

  it("carries the catalog entry's model", () => {
    const d = route({ ...config, tiers: { ...config.tiers, fast: ["qwen"] } }, req({ profile: "triager" }));
    expect(d.chosen).toEqual({ id: "qwen", adapter: "native", model: "ollama/qwen2.5:7b", provider: "ollama" });
  });

  it("tries a team lead's preference first, by catalog id or adapter, when it is usable", () => {
    expect(route(config, req({ prefer: "copilot" }))).toMatchObject({ chosen: { id: "copilot" }, reason: expect.stringContaining("preferred by the lead") });
    expect(route(config, req({ prefer: "native" })).chosen?.id).toBe("qwen");
    const exhausted = route(config, req({ prefer: "copilot", exhausted: [{ adapter: "copilot", resetsAt: "2026-10-16T00:00:00Z" }] }));
    expect(exhausted.chosen?.id).toBe("claude-code");
    expect(exhausted.skipped).toContainEqual({ id: "copilot", reason: expect.stringMatching(/preferred by the lead; quota exhausted/) });
    expect(route(config, req({ prefer: "codex" })).skipped).toContainEqual({ id: "codex", reason: "preferred by the lead; status disabled" });
    expect(route(config, req({ prefer: "nope" })).chosen?.id).toBe("claude-code");
  });
});

describe("route: allowed adapters (ADR 0069)", () => {
  it("skips entries whose adapter cannot run in the run's isolation, and says so", () => {
    const d = route(config, req({ profile: "triager", allowedAdapters: new Set(["claude-code"]) }));
    expect(d.chosen?.id).toBe("claude-code");
    expect(d.skipped).toContainEqual({ id: "copilot", reason: "copilot cannot run in the run's isolation" });
    expect(route(config, req({ allowedAdapters: new Set(["codex"]) })).chosen).toBeUndefined();
  });
});

describe("route: budget and observed metrics (ADR 0023)", () => {
  const withBudget: RouterConfig = {
    ...config,
    tiers: { ...config.tiers, standard: ["qwen", "claude-code", "copilot"] },
    quota_reserve: 0.9,
    degraded_error_rate: 0.5,
  };
  const held: RouterConfig = { ...config, quota_reserve: 0.9, degraded_error_rate: 0.5 };
  const billing = (e: { adapter: string }) => (e.adapter === "native" ? ("metered" as const) : ("plan" as const));

  it("skips a billed entry expected to cost more than the budget left", () => {
    const d = route(withBudget, req({ budgetRemaining: 0.25, billing, observed: (id) => (id === "qwen" ? { expectedCost: 0.4 } : undefined) }));
    expect(d.chosen?.id).toBe("claude-code");
    expect(d.skipped).toContainEqual({ id: "qwen", reason: "expected $0.40, $0.25 left in the budget" });
  });

  it("does not filter without history, without a limit, or for plan entries", () => {
    expect(route(withBudget, req({ budgetRemaining: 0.25, billing })).chosen?.id).toBe("qwen");
    expect(route(withBudget, req({ budgetRemaining: Infinity, billing, observed: () => ({ expectedCost: 9 }) })).chosen?.id).toBe("qwen");
    const plan = route(config, req({ budgetRemaining: 0, billing, observed: () => ({ expectedCost: 9 }) }));
    expect(plan.chosen?.id).toBe("claude-code");
  });

  it("applies the budget filter to a lead's preference", () => {
    const d = route(withBudget, req({ prefer: "qwen", budgetRemaining: 0.1, billing, observed: () => ({ expectedCost: 0.5 }) }));
    expect(d.chosen?.id).toBe("claude-code");
    expect(d.skipped[0]).toEqual({ id: "qwen", reason: "preferred by the lead; expected $0.50, $0.10 left in the budget" });
  });

  it("keeps an entry whose quota is nearly used for later", () => {
    const d = route(held, req({ quotaUse: [{ adapter: "claude-code", window: "five_hour", utilization: 0.93, resetsAt: "2026-10-15T18:00:00Z" }] }));
    expect(d.chosen?.id).toBe("copilot");
    expect(d.reason).toContain("after the others: claude-code (quota 93 % used until 2026-10-15T18:00:00Z, kept for later)");
    expect(route(held, req({ quotaUse: [{ adapter: "claude-code", window: "five_hour", utilization: 0.5 }] })).chosen?.id).toBe("claude-code");
  });

  it("puts an entry that keeps failing after the others, given enough recent tasks", () => {
    const failing = (n: number) => (id: string) => (id === "claude-code" ? { recent: { failed: n, total: Math.max(n, 4) } } : undefined);
    const d = route(withBudget, req({ observed: failing(4), billing, budgetRemaining: Infinity, exclude: ["qwen"] }));
    expect(d.chosen?.id).toBe("copilot");
    expect(d.reason).toContain("claude-code (4 of 4 tasks failed in 24 h)");
    expect(route(held, req({ observed: () => ({ recent: { failed: 3, total: 3 } }) })).chosen?.id).toBe("claude-code");
    expect(route(held, req({ observed: failing(1) })).chosen?.id).toBe("claude-code");
  });

  it("still uses a held-back entry when it is the only usable one", () => {
    const d = route(held, req({ adapters: new Set(["claude-code"]), quotaUse: [{ adapter: "claude-code", window: "seven_day", utilization: 0.95 }] }));
    expect(d.chosen?.id).toBe("claude-code");
    expect(d.reason).toContain("every candidate in tier standard is held back, using claude-code (quota 95 % used, kept for later)");
  });
});
