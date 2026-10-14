import type { Actor, ToolGrant } from "@vectr/contracts";

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
    match: (r) => r.action === "git.push" && glob("vectr/*", r.context.branch),
    effect: "allow",
    reason: "push to vectr/* branches is allowed",
  },
  { match: (r) => r.action === "git.push", effect: "deny", reason: "push outside vectr/* is never allowed" },
  {
    match: (r) => r.action === "github.pr.merge",
    effect: "require_approval",
    reason: "merge requires approval unless auto-merge is enabled (spec §11.1)",
  },
  {
    match: (r) => r.action === "task.start" && r.context.autonomyLevel < 1,
    effect: "require_approval",
    reason: "autonomy level 0 (observe) requires approval for any agent execution",
  },
  {
    match: (r) => r.action === "task.start" && (r.context.budgetRemaining ?? 1) <= 0,
    effect: "require_approval",
    reason: "run budget exhausted",
  },
  { match: (r) => r.action === "task.start", effect: "allow", reason: "agent task within budget" },
  {
    match: (r) => r.action === "cmd.exec" && !commandAllowed(r.context.command ?? "", r.context.allowCommands ?? []),
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
   * Tool grant for the Claude Code adapter, in Claude Code permission-rule syntax. Commands
   * outside the allowlist are not granted; headless runs then deny them instead of prompting.
   */
  claudeCodeGrant(allowCommands: string[]): ToolGrant {
    const base = ["Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "LS", "TodoWrite", "NotebookEdit"];
    const readOnlyGit = ["git status", "git diff *", "git log *", "git show *", "git add *", "git commit *"];
    const commands = [...readOnlyGit, ...allowCommands].map(toBashRule);
    return {
      allow: [...base, ...commands],
      deny: [
        "Bash(git push:*)",
        "Bash(git remote:*)",
        "Bash(git config:*)",
        "Bash(git worktree:*)",
        "Bash(sudo:*)",
        "Bash(ssh:*)",
        "Bash(curl:*)",
        "Bash(wget:*)",
        "Read(~/.ssh/**)",
        "Read(~/.vectr/**)",
        "Read(~/.aws/**)",
        "Read(~/.config/gh/**)",
        "Edit(~/.ssh/**)",
        "Edit(~/.vectr/**)",
        "WebFetch",
        "WebSearch",
      ],
    };
  }
}

/** `npm test` → `Bash(npm test)`, `npm run *` → `Bash(npm run:*)`. */
export function toBashRule(command: string): string {
  const trimmed = command.trim();
  if (trimmed.endsWith(" *")) return `Bash(${trimmed.slice(0, -2)}:*)`;
  return `Bash(${trimmed})`;
}

export function commandAllowed(command: string, allowlist: string[]): boolean {
  return allowlist.some((pattern) => glob(pattern.trim(), command.trim()));
}
