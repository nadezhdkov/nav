import type { AgentProfile } from "@vectr/contracts";

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

export function buildInstructions(profile: AgentProfile, prompt: string): string {
  return `${profile.instructions}\n\n<task>\n${prompt}\n</task>\n`;
}
