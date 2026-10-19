import { z } from "zod";

/** One rule of a project (spec §6.8.3, ADR 0047): short, one line, in the user's words. */
export const PrincipleText = z.string().trim().min(3).max(300).refine((t) => !/[\r\n]/.test(t), "a principle is one line");

/** Where a rule comes from: the user's approved list or the repository's `.navarch/principles.md`. */
export const PrincipleSource = z.enum(["user", "file"]);
export type PrincipleSource = z.infer<typeof PrincipleSource>;

export const PrincipleView = z.object({
  /** `prin_…` for the user's rules; `file:<n>` for lines of the repository file. */
  id: z.string(),
  text: z.string(),
  source: PrincipleSource,
  added_at: z.string().nullable(),
  /** The run whose decision the user turned into this rule, when they said so. */
  run_id: z.string().nullable(),
});
export type PrincipleView = z.infer<typeof PrincipleView>;

/** A rule an agent suggested, waiting for the user (ADR 0056). Nothing applies it until the user accepts. */
export const PrincipleProposalView = z.object({
  id: z.string(),
  text: z.string(),
  /** Why the agent thinks future agents need it; untrusted text, shown as such. */
  reason: z.string(),
  run_id: z.string().nullable(),
  proposed_at: z.string(),
});
export type PrincipleProposalView = z.infer<typeof PrincipleProposalView>;

export const PrinciplesView = z.object({
  project_id: z.string(),
  principles: z.array(PrincipleView),
  /** Rules agents suggested that the user has not decided on yet, oldest first. */
  proposals: z.array(PrincipleProposalView),
  /** Rules cut from the file for being too many or too long (see `MAX_PRINCIPLES`). */
  truncated: z.boolean(),
});
export type PrinciplesView = z.infer<typeof PrinciplesView>;

export const AddPrincipleRequest = z.object({ text: PrincipleText, run_id: z.string().optional() });
export type AddPrincipleRequest = z.infer<typeof AddPrincipleRequest>;

/** At most this many rules reach an agent's prompt, the user's first. */
export const MAX_PRINCIPLES = 30;

// --- proposals (ADR 0056) ---

/** Profiles whose summaries may carry proposals: they see the conventions of the change, not just its result. */
export const PROPOSING_PROFILES: readonly string[] = ["planner", "reviewer"];
/** At most this many proposals from one task, and this many waiting for a project at once. */
export const MAX_PROPOSALS_PER_TASK = 3;
export const MAX_PENDING_PROPOSALS = 10;

const ProposedRule = z.object({ text: PrincipleText, reason: z.string().trim().min(1).max(300).refine((t) => !/[\r\n]/.test(t), "the reason is one line") });
const ProposalsBlock = z.object({ rules: z.array(z.unknown()).max(20) });
const BLOCK = /```navarch-principles[ \t]*\r?\n([\s\S]*?)```/g;

/**
 * Reads the last `navarch-principles` block of an agent's summary: `{ "rules": [{ "text", "reason" }] }`.
 * Rules that do not fit (several lines, too long, no reason) are dropped one by one, and no more than
 * `MAX_PROPOSALS_PER_TASK` are kept. A summary with no block proposes nothing.
 */
export function parsePrincipleProposals(summary: string): { rules: { text: string; reason: string }[] } {
  const raw = [...summary.matchAll(BLOCK)].at(-1)?.[1];
  if (raw === undefined) return { rules: [] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { rules: [] };
  }
  const block = ProposalsBlock.safeParse(json);
  if (!block.success) return { rules: [] };
  const rules: { text: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const candidate of block.data.rules) {
    const rule = ProposedRule.safeParse(candidate);
    if (!rule.success || seen.has(rule.data.text.toLowerCase())) continue;
    seen.add(rule.data.text.toLowerCase());
    rules.push(rule.data);
    if (rules.length >= MAX_PROPOSALS_PER_TASK) break;
  }
  return { rules };
}
