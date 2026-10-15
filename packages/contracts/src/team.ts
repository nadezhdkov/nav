import { z } from "zod";

/**
 * Team mode (ADR 0022): a lead agent works in turns, and each turn ends with a team plan in a
 * fenced `navarch-team` block. The plan adds members (agents routed like any task), says whether
 * the work is done, or asks the user a question. It has no field that could change autonomy,
 * grants, budgets or merging.
 */

/** Profiles a lead may give a member. */
export const TeamMemberProfile = z.enum(["planner", "researcher", "implementer", "reviewer"]);
export type TeamMemberProfile = z.infer<typeof TeamMemberProfile>;

export const TeamMemberKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "member keys are 1–32 lowercase letters, digits and -");

export const TeamMemberSpec = z.strictObject({
  key: TeamMemberKey,
  title: z.string().trim().min(1).max(120),
  /** What the member must do; it becomes the member's brief, inside its prompt. */
  brief: z.string().trim().min(1).max(8_000),
  profile: TeamMemberProfile,
  /** An adapter id or catalog entry tried first when it is usable; routing still decides. */
  prefer: z.string().min(1).max(80).optional(),
  /** Members (of this or earlier turns) that must finish first. */
  depends_on: z.array(TeamMemberKey).default([]),
});
export type TeamMemberSpec = z.infer<typeof TeamMemberSpec>;

export const TeamPlan = z.strictObject({
  /** What the lead did and decided this turn; the last one is the team's summary. */
  summary: z.string().trim().min(1).max(8_000),
  /** True when the lead considers the work finished (the checks must pass too). */
  done: z.boolean(),
  /** A question for the user; the team waits for an answer. */
  question: z.string().trim().min(1).max(2_000).nullable().default(null),
  members: z.array(TeamMemberSpec).max(12).default([]),
});
export type TeamPlan = z.infer<typeof TeamPlan>;

/** Which part of a team a task is. */
export const TeamTaskRole = z.enum(["lead", "member", "verify", "approval"]);
export type TeamTaskRole = z.infer<typeof TeamTaskRole>;

export const TeamTaskRef = z.object({
  node_id: z.string(),
  role: TeamTaskRole,
  /** Member key, for members. */
  key: z.string().optional(),
});
export type TeamTaskRef = z.infer<typeof TeamTaskRef>;

const BLOCK = /```navarch-team[ \t]*\r?\n([\s\S]*?)```/g;

/**
 * Reads the last `navarch-team` block of a lead turn's summary. `earlierKeys` are the members
 * added by earlier turns: new keys must differ from them, and dependencies may name them.
 */
export function parseTeamPlan(summary: string, earlierKeys: readonly string[] = []): { ok: true; plan: TeamPlan } | { ok: false; error: string } {
  const blocks = [...summary.matchAll(BLOCK)];
  const raw = blocks.at(-1)?.[1];
  if (raw === undefined) return { ok: false, error: "no ```navarch-team block at the end of the turn" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `the navarch-team block is not valid JSON: ${(err as Error).message}` };
  }
  const parsed = TeamPlan.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { ok: false, error: `navarch-team ${issue.path.join(".") || "plan"}: ${issue.message}` };
  }
  const plan = parsed.data;
  if (plan.question && plan.members.length) return { ok: false, error: "a turn that asks a question adds no members; ask first, delegate after the answer" };
  const known = new Set(earlierKeys);
  for (const m of plan.members) {
    if (known.has(m.key)) return { ok: false, error: `member key "${m.key}" is already used; pick a new key` };
    const missing = m.depends_on.find((d) => !known.has(d));
    if (missing) return { ok: false, error: `member "${m.key}" depends on "${missing}", which is not an earlier member` };
    known.add(m.key);
  }
  return { ok: true, plan };
}
