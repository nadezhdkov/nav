import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { commandAllowed, matchesPattern } from "@navarch/adapter-kit";
import type { ToolGrant } from "@navarch/contracts";

/**
 * Navarch's guard for Grok tool calls, run as a global `PreToolUse` hook (ADR 0024). Grok's own
 * rules leave gaps: in `dontAsk` mode it still runs commands it considers safe for the workspace
 * (`touch`, `mkdir`) even for a read-only task. The guard checks every shell command against the
 * grant exactly, keeps file edits inside the worktree, and keeps reads out of the denied paths.
 * Grok's deny-by-default rules stay underneath, since a hook that fails lets the call through.
 */

export type GuardPolicy = { grant: ToolGrant; root: string; home?: string };
export type GuardEvent = { toolName?: string; toolInput?: Record<string, unknown> };
export type GuardDecision = { decision: "deny"; reason: string } | undefined;

const SHELL_TOOLS = new Set(["run_terminal_command", "run_terminal_cmd", "Bash"]);
const EDIT_TOOLS = new Set(["search_replace", "write", "Edit", "Write", "MultiEdit"]);
const READ_TOOLS = new Set(["read_file", "list_dir", "grep", "Read", "Grep", "Glob", "LS"]);

/**
 * Commands any task may run without being on the allowlist: they only read. Options that make
 * them write or run other programs (`git diff --output`, `--ext-diff`, `rg --pre`) are refused.
 */
const READ_ONLY = ["ls", "ls *", "pwd", "cat *", "head *", "tail *", "wc *", "grep *", "rg *", "git status", "git status *", "git diff", "git diff *", "git log", "git log *", "git show", "git show *"];
const UNSAFE_OPTION = /\s--(output|ext-diff|pre|textconv)\b/;

/** Shell syntax that runs or redirects something the segments do not show. */
const HIDDEN = /[`$<>(){}\\]/;

export function guardDecision(event: GuardEvent, policy: GuardPolicy): GuardDecision {
  const name = event.toolName ?? "";
  const input = event.toolInput ?? {};
  const home = policy.home ?? homedir();
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");

  if (SHELL_TOOLS.has(name)) {
    const command = str("command").trim();
    return shellAllowed(command, policy.grant, home) ? undefined : deny(`\`${command.slice(0, 200)}\` is not in this task's allowed commands`);
  }
  const path = str("file_path") || str("target_file") || str("path");
  if (EDIT_TOOLS.has(name)) {
    if (!policy.grant.editFiles) return deny("this task may not edit files");
    if (path && outside(resolve(policy.root, path), policy.root)) return deny(`${path} is outside the worktree`);
    return undefined;
  }
  if (READ_TOOLS.has(name) && path && namesDeniedPath(resolve(policy.root, path), policy.grant.denyPaths, home)) {
    return deny(`${path} is a denied path`);
  }
  return undefined;
}

function deny(reason: string): GuardDecision {
  return { decision: "deny", reason: `Navarch guard: ${reason}.` };
}

/** Every segment of a chain must be allowlisted or read-only; nothing may be hidden in it. */
export function shellAllowed(command: string, grant: ToolGrant, home = homedir()): boolean {
  if (!command || HIDDEN.test(command)) return false;
  if (grant.denyPaths.some((p) => command.includes(p) || command.includes(expandHome(p, home)))) return false;
  const segments = command.split(/&&|\|\||[;|\n]/).map((s) => s.trim().replace(/\s+/g, " "));
  return segments.every(
    (s) =>
      s !== "" &&
      (commandAllowed(s, grant.allowCommands, grant.denyCommands) ||
        (!UNSAFE_OPTION.test(` ${s} `) && !grant.denyCommands.some((d) => matchesPattern(s, `${d} *`)) && READ_ONLY.some((p) => matchesPattern(s, p)))),
  );
}

const expandHome = (path: string, home: string) => path.replace(/^~(?=\/|$)/, home);

function outside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
}

function namesDeniedPath(path: string, denyPaths: string[], home: string): boolean {
  return denyPaths.some((p) => {
    const denied = resolve(expandHome(p, home));
    return path === denied || path.startsWith(`${denied}/`);
  });
}
