import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { Config } from "../src/config.ts";

describe("routing config", () => {
  it("adds catalog entries to the built-in ones, and the free-models example is valid", () => {
    const example = parse(readFileSync(new URL("../../../docs/examples/free-models.yaml", import.meta.url), "utf8"));
    const config = Config.parse(example);
    expect(Object.keys(config.routing.models)).toEqual(
      expect.arrayContaining(["claude-code", "copilot", "laguna-s-free", "zen-big-pickle"]),
    );
    expect(config.routing.models["zen-big-pickle"]).toMatchObject({ adapter: "opencode", model: "opencode/big-pickle" });
    expect(config.routing.models["laguna-s-free"]).toMatchObject({ adapter: "native", model: "openrouter/poolside/laguna-s-2.1:free", status: "active" });
    for (const id of Object.values(config.routing.tiers).flat()) expect(config.routing.models[id], id).toBeDefined();
    // Keys come from the Vault: providers name a secret, never hold a key.
    expect(config.adapters.native.providers["opencode-zen"]).toEqual({ base_url: "https://opencode.ai/inference/v1", api_key: "secret://opencode/api_key" });
    expect(config.adapters.native.providers.openrouter?.api_key).toBe("secret://openrouter/api_key");
  });

  it("lists Kilo's free models in the catalog but in no tier by default (ADR 0034)", () => {
    const config = Config.parse({});
    expect(config.routing.models.kilo).toEqual({ adapter: "kilo", model: "kilo/kilo-auto/free", provider: "kilo", status: "active" });
    expect(Object.values(config.routing.tiers).flat()).not.toContain("kilo");
    expect(config.adapters.kilo).toEqual({ enabled: true, model: "kilo/kilo-auto/free" });
  });

  it("refuses a provider key written into the config", () => {
    expect(() => Config.parse({ adapters: { native: { providers: { x: { base_url: "https://x.example/v1", api_key: "sk-live-123" } } } } })).toThrow();
  });
});
