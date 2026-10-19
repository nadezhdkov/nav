import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { Config } from "../src/config.ts";
import { ProjectConfig, resolveIsolation } from "../src/project.ts";

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

describe("isolation (ADR 0035)", () => {
  it("runs on the host unless the project or the daemon asks for a container", () => {
    const config = Config.parse({});
    expect(resolveIsolation(ProjectConfig.parse({}), config)).toBeUndefined();
    expect(resolveIsolation(ProjectConfig.parse({ isolation: "container" }), config)).toEqual({ kind: "container", image: "node:22-bookworm-slim", network: "none", memory: "4g", cpus: 2, pids_limit: 1024 });
    const containers = Config.parse({ security: { default_isolation: "container" }, container: { image: "ci:1" } });
    expect(resolveIsolation(ProjectConfig.parse({ container: { network: "bridge", cpus: 4 } }), containers)).toMatchObject({ image: "ci:1", network: "bridge", cpus: 4 });
    // A project may still choose the host when the daemon defaults to containers.
    expect(resolveIsolation(ProjectConfig.parse({ isolation: "worktree" }), containers)).toBeUndefined();
    expect(() => ProjectConfig.parse({ container: { memory: "lots" } })).toThrow();
    // L3 (ADR 0069): no network for checks, the agent's image and extra hosts come from the daemon, never the repository.
    const l3 = Config.parse({ container: { agent_image: "agents:1", oci_runtime: "runsc", egress_allow: ["*.corp.test"] } });
    expect(resolveIsolation(ProjectConfig.parse({ isolation: "hardened", container: { network: "bridge" } }), l3)).toEqual({
      kind: "container", image: "node:22-bookworm-slim", network: "none", memory: "4g", cpus: 2, pids_limit: 1024,
      hardened: { agent_image: "agents:1", oci_runtime: "runsc", egress_allow: ["*.corp.test"] },
    });
    expect(resolveIsolation(ProjectConfig.parse({ isolation: "hardened" }), Config.parse({}))?.hardened).toEqual({ agent_image: "navarch-agent:latest", egress_allow: [] });
    // A repository cannot lower what the daemon sets for every project.
    const strict = Config.parse({ security: { default_isolation: "hardened" } });
    expect(resolveIsolation(ProjectConfig.parse({ isolation: "worktree" }), strict)?.hardened).toBeDefined();
    expect(resolveIsolation(ProjectConfig.parse({ isolation: "container" }), strict)?.hardened).toBeDefined();
    expect(() => Config.parse({ container: { egress_allow: ["bad host"] } })).toThrow();
    // An image that the runtime would read as a flag.
    expect(() => ProjectConfig.parse({ container: { image: "--privileged" } })).toThrow();
  });
});
