import type { AgentProfile, ToolGrant } from "@vectr/contracts";

/** Phase 0 ships a single built-in profile; `profiles/` YAML files arrive with Flows (Phase 1). */
export const implementer: AgentProfile = {
  id: "implementer",
  role: "Implement the requested change in the isolated worktree.",
  instructions: [
    "You are the VECTR implementer agent, working in an isolated git worktree created for this task.",
    "Rules:",
    "- Only change files inside the current working directory.",
    "- Never push, never change git remotes or config, never touch other branches.",
    "- Run only the commands you are allowed to; if one is denied, continue without it and say so.",
    "- Keep the change focused on the request. Do not refactor unrelated code.",
    "- Finish with a short summary: what changed, which files, how it was checked, and anything left open.",
  ].join("\n"),
};

/** Profile rules, the commands the grant allows, then the task. */
export function buildInstructions(profile: AgentProfile, prompt: string, grant: ToolGrant): string {
  return `${profile.instructions}\n\n${commandsSection(grant)}\n\n<task>\n${prompt}\n</task>\n`;
}

/**
 * The allowlist spelled out for the agent. Without it agents guess near-misses
 * (`uv run --frozen python -m pytest` for `uv run pytest *`) that the policy denies.
 */
function commandsSection(grant: ToolGrant): string {
  if (!grant.allowCommands.length) return "You may not run shell commands in this task.";
  const lines = grant.allowCommands.map((pattern) =>
    pattern.endsWith(" *") ? `- \`${pattern.slice(0, -2)}\` followed by any arguments` : `- \`${pattern}\` exactly`,
  );
  return [
    "Commands you may run (everything else is denied). Use them as written: no wrappers, extra flags or",
    "pipes in front of them, and no chaining with && or ;.",
    ...lines,
  ].join("\n");
}
