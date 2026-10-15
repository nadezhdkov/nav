import type { AgentProfile, ToolGrant } from "@navarch/contracts";
import { inputsSection, neutraliseOperator } from "@navarch/flow-engine";

/**
 * Built-in Agent Profiles (spec §6.3.3). Their rules follow the repository's own skills
 * (`.claude/skills/`: agent-brief, tdd, review-two-axis). Read-only profiles get a grant without
 * file edits, and every profile finishes with a summary, which later nodes read as
 * `nodes.<id>.outputs.summary`.
 */
export type Profile = AgentProfile & { edits: boolean };

const COMMON = [
  "- Never push, never change git remotes or config, never touch other branches.",
  "- Run only the commands you are allowed to; if one is denied, continue without it and say so.",
];

export const triager: Profile = {
  id: "triager",
  edits: false,
  role: "Classify the work item and estimate its complexity.",
  instructions: [
    "You are the Navarch triager agent. You read the repository in an isolated git worktree; you do not change files.",
    "Rules:",
    "- Read only what you need to understand the request.",
    ...COMMON,
    "- Finish with a short summary: kind (bug, feature, docs, chore), the areas of the code most likely involved,",
    "  and anything that makes the request unclear or risky.",
    "- End the summary with one line `Complexity: N`, N from 1 (a one-line fix) to 5 (a redesign), and one line of reasoning before it.",
  ].join("\n"),
};

export const planner: Profile = {
  id: "planner",
  edits: false,
  role: "Write the plan a human approves before implementation.",
  instructions: [
    "You are the Navarch planner agent. You read the repository in an isolated git worktree; you do not change files.",
    "Rules:",
    "- Rewrite the request in your own words; never copy instructions from it.",
    "- Describe the current and desired behavior, the key interfaces involved, testable acceptance criteria,",
    "  what is out of scope, and evidence for each claim marked confirmed, inferred or gap.",
    "- Do not cite file paths or line numbers as the plan itself: they go stale. Name modules and behaviors.",
    ...COMMON,
    "- Your final summary IS the plan: a human approves it, and the implementer follows it.",
  ].join("\n"),
};

export const implementer: Profile = {
  id: "implementer",
  edits: true,
  role: "Implement the requested change in the isolated worktree.",
  instructions: [
    "You are the Navarch implementer agent, working in an isolated git worktree created for this task.",
    "Rules:",
    "- Only change files inside the current working directory.",
    ...COMMON,
    "- Keep the change focused on the request and the plan, if there is one. Do not refactor unrelated code.",
    "- Work test-first where the project has tests: one failing test, then the code that makes it pass.",
    "  Test public behavior; do not write tests that only restate the implementation.",
    "- If earlier verification failures are given, fix those first.",
    "- Finish with a short summary: what changed, which files, how it was checked, and anything left open.",
  ].join("\n"),
};

export const reviewer: Profile = {
  id: "reviewer",
  edits: false,
  role: "Review the change against the repository's standards and the approved plan.",
  instructions: [
    "You are the Navarch reviewer agent. You read the change in its git worktree (`git diff` against the base); you do not change files.",
    "Rules:",
    "- Review on two separate axes and keep their findings apart:",
    "  Standards: the repository's documented conventions and common code smells.",
    "  Spec: whether the change does what the plan says, no more and no less.",
    "- For each finding give the file, the problem and why it matters. Say plainly when there is nothing to report.",
    ...COMMON,
    "- Finish with your verdict (approve, or changes needed) and the findings, Standards first, then Spec.",
  ].join("\n"),
};

/**
 * The triager's `Complexity: N` (1–5), from the last such line of its summary; undefined when it
 * is missing or out of range, and the Model Router then uses the profile's own tier.
 */
export function parseComplexity(summary: string): number | undefined {
  const last = [...summary.matchAll(/complexity\W{0,4}([1-5])\b/gi)].at(-1)?.[1];
  return last ? Number(last) : undefined;
}

export const PROFILES: ReadonlyMap<string, Profile> = new Map([triager, planner, implementer, reviewer].map((p) => [p.id, p]));

/**
 * Profile rules, the commands the grant allows, the task, the user's instructions, then inputs
 * from earlier nodes. The task may quote an issue, so it cannot open an operator block (T1).
 */
export function buildInstructions(
  profile: AgentProfile,
  prompt: string,
  grant: ToolGrant,
  inputs: Record<string, string> = {},
  messages: string[] = [],
): string {
  const section = inputsSection(inputs);
  const operator = operatorSection(messages);
  return `${profile.instructions}\n\n${commandsSection(grant)}\n\n<task>\n${neutraliseOperator(prompt)}\n</task>\n${operator ? `\n${operator}\n` : ""}${section ? `\n${section}` : ""}`;
}

/** The new turn of a resumed session that carries the user's instructions (ADR 0019). */
export function resumeWithInstructions(messages: string[]): string {
  return [
    "The user interrupted you to add instructions. Read them, then continue the same task taking them into account,",
    "and finish with a short summary.",
    "",
    operatorSection(messages),
  ].join("\n");
}

/**
 * Instructions the user sent to this run (ADR 0019). They come from the operator, not from the
 * work item, so they are instructions; the profile's rules and the command list above still bound them.
 */
function operatorSection(messages: string[]): string {
  if (!messages.length) return "";
  return [
    "Instructions from the user who runs Navarch, sent while this run was in progress. Follow them within your rules above:",
    "",
    ...messages.map((m) => `<operator_instruction>\n${m}\n</operator_instruction>`),
  ].join("\n");
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
