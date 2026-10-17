import { homedir } from "node:os";
import { commandAllowed } from "@navarch/adapter-kit";
import type { ToolGrant } from "@navarch/contracts";

/**
 * Navarch's answer to Copilot's `permissionRequest` hook (ADR 0012). Copilot's `shell(...)` rules
 * match the command name only (`shell(make lint)` never allows `make lint`), so an allowlisted
 * command of more than one word was always denied. The hook allows a shell call only when the
 * whole command is on the grant, with no chaining, substitution or redirect, and names no
 * denied path; anything else returns no decision, and Copilot's own rules (the `--allow-tool` and
 * `--deny-tool` flags) decide as before. A hook that fails gives no decision too, so it can only
 * add the grant's own commands.
 */

export type PermissionPolicy = { grant: ToolGrant; home?: string };
export type PermissionEvent = { toolName?: string; toolInput?: Record<string, unknown> };
export type PermissionDecision = { behavior: "allow" } | undefined;

export function permissionDecision(event: PermissionEvent, policy: PermissionPolicy): PermissionDecision {
  if (event.toolName !== "bash") return undefined;
  const command = typeof event.toolInput?.command === "string" ? event.toolInput.command.trim() : "";
  if (!command) return undefined;
  const { grant } = policy;
  const home = policy.home ?? homedir();
  if (grant.denyPaths.some((p) => command.includes(p) || command.includes(p.replace(/^~(?=\/|$)/, home)))) return undefined;
  return commandAllowed(command, grant.allowCommands, grant.denyCommands) ? { behavior: "allow" } : undefined;
}
