import type { Actor } from "@vectr/contracts";
import { describe, expect, it } from "vitest";
import { PolicyEngine, toBashRule } from "../src/policy/engine.ts";

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

  it("builds a Claude Code grant that never allows push or secret paths", () => {
    const grant = policy.claudeCodeGrant(["npm test", "npm run *"]);
    expect(grant.allow).toContain("Bash(npm test)");
    expect(grant.allow).toContain("Bash(npm run:*)");
    expect(grant.deny).toEqual(expect.arrayContaining(["Bash(git push:*)", "Read(~/.ssh/**)", "Read(~/.vectr/**)"]));
    expect(toBashRule("cargo test *")).toBe("Bash(cargo test:*)");
  });
});
