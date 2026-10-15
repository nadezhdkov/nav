import { commandAllowed } from "@navarch/adapter-kit";
import type { Actor, ToolGrant } from "@navarch/contracts";

/**
 * Policy & Approval Engine (spec §6.10). Every side effect is decided here; Phase 0 implements
 * the declarative rule matcher plus the rules needed to start agent tasks safely.
 */

export type PolicyEffect = "allow" | "deny" | "require_approval";

export type PolicyContext = {
  autonomyLevel: number;
  budgetRemaining?: number;
  branch?: string;
  command?: string;
  allowCommands?: string[];
  /** For `task.start`: whether the agent's profile edits files. */
  edits?: boolean;
  /** For `inbox.triage`: today's triage so far and the daily caps (ADR 0021). */
  usage?: { items: number; usd: number };
  cap?: { items: number; usd: number };
};

export type PolicyRequest = {
  actor: Actor;
  action: string;
  resource: string;
  context: PolicyContext;
};

export type PolicyDecision = { effect: PolicyEffect; reason: string };

export type PolicyRule = {
  match: (req: PolicyRequest) => boolean;
  effect: PolicyEffect;
  reason: string;
};

const glob = (pattern: string, value: string | undefined): boolean => {
  if (value === undefined) return false;
  const re = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return re.test(value);
};

function escapeRegExp(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Default rules, first match wins. Mirrors the examples in spec §6.10.2 and the levels in §11. */
export const defaultRules: PolicyRule[] = [
  {
    match: (r) => r.action === "git.push" && glob("navarch/*", r.context.branch),
    effect: "allow",
    reason: "push to navarch/* branches is allowed",
  },
  { match: (r) => r.action === "git.push", effect: "deny", reason: "push outside navarch/* is never allowed" },
  {
    match: (r) => r.action === "github.pr.merge",
    effect: "require_approval",
    reason: "merge requires approval unless auto-merge is enabled (spec §11.1)",
  },
  {
    match: (r) => r.action === "github.pr.create" && r.context.autonomyLevel >= 3,
    effect: "allow",
    reason: "autonomy level 3+ opens draft PRs on navarch/* branches",
  },
  {
    match: (r) => r.action === "github.pr.create",
    effect: "require_approval",
    reason: "opening a PR requires approval below autonomy level 3",
  },
  {
    match: (r) => r.action === "verification.run" && r.context.autonomyLevel >= 2,
    effect: "allow",
    reason: "autonomy level 2+ runs local verification",
  },
  {
    match: (r) => r.action === "verification.run",
    effect: "require_approval",
    reason: "running verification commands requires approval below autonomy level 2",
  },
  {
    match: (r) => r.action === "run.message" && r.actor.kind === "user",
    effect: "allow",
    reason: "the user may instruct their own runs (ADR 0019)",
  },
  { match: (r) => r.action === "run.message", effect: "deny", reason: "only the user sends instructions to a run" },
  {
    match: (r) => (r.action === "run.pause" || r.action === "run.resume" || r.action === "fleet.stop") && r.actor.kind === "user",
    effect: "allow",
    reason: "the user may pause, resume and stop their own runs (ADR 0020)",
  },
  {
    match: (r) => r.action === "run.pause" || r.action === "run.resume" || r.action === "fleet.stop",
    effect: "deny",
    reason: "only the user pauses, resumes or stops runs",
  },
  {
    match: (r) => r.action === "notification.send" && r.actor.kind === "system",
    effect: "allow",
    reason: "the daemon notifies the user's paired devices (ADR 0020)",
  },
  { match: (r) => r.action === "notification.send", effect: "deny", reason: "only the daemon sends notifications" },
  {
    match: (r) => (r.action === "project.add" || r.action === "project.remove") && r.actor.kind === "user",
    effect: "allow",
    reason: "the user chooses which repositories the Inbox watches (ADR 0021)",
  },
  { match: (r) => r.action === "project.add" || r.action === "project.remove", effect: "deny", reason: "only the user adds or removes projects" },
  {
    match: (r) => r.action === "inbox.sync" && (r.actor.kind === "user" || r.actor.kind === "system"),
    effect: "allow",
    reason: "reading issues of registered projects (ADR 0021)",
  },
  { match: (r) => r.action === "inbox.sync", effect: "deny", reason: "only the user or the daemon syncs the Inbox" },
  {
    match: (r) =>
      r.action === "inbox.triage" &&
      (!r.context.usage || !r.context.cap || r.context.usage.items >= r.context.cap.items || r.context.usage.usd >= r.context.cap.usd),
    effect: "deny",
    reason: "daily Inbox triage limit reached",
  },
  {
    match: (r) => r.action === "inbox.triage" && r.actor.kind === "system",
    effect: "allow",
    reason: "Inbox triage within the daily limits (ADR 0021)",
  },
  { match: (r) => r.action === "inbox.triage", effect: "deny", reason: "only the daemon triages the Inbox" },
  {
    match: (r) => r.action === "flow.approval",
    effect: "require_approval",
    reason: "the flow asks a human at this step",
  },
  {
    match: (r) => r.action === "task.start" && (r.context.budgetRemaining ?? 1) <= 0,
    effect: "deny",
    reason: "run budget exhausted",
  },
  {
    match: (r) => r.action === "task.start" && r.context.autonomyLevel < 1,
    effect: "require_approval",
    reason: "autonomy level 0 (observe) requires approval for any agent execution",
  },
  {
    match: (r) => r.action === "task.start" && r.context.edits === true && r.context.autonomyLevel < 2,
    effect: "require_approval",
    reason: "autonomy level 1 (analyse) requires approval to edit files",
  },
  { match: (r) => r.action === "task.start", effect: "allow", reason: "agent task within budget" },
  {
    match: (r) =>
      r.action === "cmd.exec" &&
      !commandAllowed(r.context.command ?? "", r.context.allowCommands ?? [], ALWAYS_DENIED_COMMANDS),
    effect: "require_approval",
    reason: "command is not in the allowlist",
  },
  { match: (r) => r.action === "cmd.exec", effect: "allow", reason: "command is in the allowlist" },
];

export class PolicyEngine {
  private readonly rules: PolicyRule[];

  constructor(rules: PolicyRule[] = defaultRules) {
    this.rules = rules;
  }

  decide(actor: Actor, action: string, resource: string, context: PolicyContext): PolicyDecision {
    const req = { actor, action, resource, context };
    for (const rule of this.rules) {
      if (rule.match(req)) return { effect: rule.effect, reason: rule.reason };
    }
    return { effect: "deny", reason: `no rule allows ${action}` };
  }

  /**
   * What an agent task may do, in neutral terms; each adapter translates it to its agent's own
   * mechanism. Commands outside the allowlist are not granted: headless agents deny them
   * instead of prompting.
   */
  taskGrant(allowCommands: string[], edits = true): ToolGrant {
    return {
      editFiles: edits,
      // Read-only profiles (triage, plan, review) get git's read commands and nothing that writes.
      allowCommands: edits ? [...SAFE_GIT, ...allowCommands] : READ_GIT,
      denyCommands: ALWAYS_DENIED_COMMANDS,
      denyPaths: ["~/.ssh", "~/.navarch", "~/.aws", "~/.config/gh", "~/.gnupg"],
      network: false,
    };
  }
}

const READ_GIT = ["git status", "git diff *", "git log *", "git show *"];
const SAFE_GIT = [...READ_GIT, "git add *", "git commit *"];

/** Command prefixes denied in every task (spec §6.5.3). */
export const ALWAYS_DENIED_COMMANDS = [
  "git push",
  "git remote",
  "git config",
  "git worktree",
  "sudo",
  "ssh",
  "curl",
  "wget",
];

