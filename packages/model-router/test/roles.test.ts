import { describe, expect, it } from "vitest";
import { IMPLEMENTING_PROFILES } from "../../contracts/src/index.ts";
import { tierFor, type RouterConfig } from "../src/index.ts";

const config: RouterConfig = { models: {}, tiers: { fast: [], standard: [], expert: [] }, profiles: { backend: "standard" }, simple_max_complexity: 2, different_provider: [] };

describe("role profiles (ADR 0050)", () => {
  it("routes implementing roles like the implementer: simple work goes fast, a failed check escalates", () => {
    for (const profile of IMPLEMENTING_PROFILES) {
      expect(tierFor(config, { profile, complexity: 1, iteration: 1 }).tier, profile).toBe("fast");
      expect(tierFor(config, { profile, complexity: 4, iteration: 2 }).tier, profile).toBe("expert");
    }
  });

  it("does not escalate or shorten the read-only architecture role", () => {
    expect(tierFor(config, { profile: "architecture", complexity: 1, iteration: 2 })).toMatchObject({ tier: "standard" });
  });
});
