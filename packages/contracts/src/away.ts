import { z } from "zod";

/**
 * Away mode (ADR 0039): while the user is busy, an approver agent reads what would wait for them
 * and approves it, asks for a better plan, or leaves it to them.
 */

/** What the user lets the approver decide: the plan gate, opening the draft PR, starting agents. */
export const AwayDelegate = z.enum(["plan", "pr", "start"]);
export type AwayDelegate = z.infer<typeof AwayDelegate>;

export const AwayVerdict = z.enum(["approve", "revise", "escalate"]);
export type AwayVerdict = z.infer<typeof AwayVerdict>;

/** Settings the user confirmed when turning the mode on. */
export const AwaySettings = z.object({
  delegate: z.array(AwayDelegate).min(1),
  /** The mode turns itself off then; null stays on until the user turns it off. */
  until: z.string().nullable(),
  /** Runs the triage rates above this are left to the user; null: no limit. */
  max_complexity: z.number().int().min(1).max(5).nullable(),
  /** How many times the approver may send one plan back (0 turns revising off). */
  max_revisions: z.number().int().min(0).max(3),
});
export type AwaySettings = z.infer<typeof AwaySettings>;

export const AwayReviewView = z.object({
  approval_id: z.string(),
  run_id: z.string().nullable(),
  run_name: z.string().nullable(),
  subject: AwayDelegate,
  verdict: AwayVerdict,
  reason: z.string(),
  model: z.string(),
  at: z.string(),
});
export type AwayReviewView = z.infer<typeof AwayReviewView>;

export const AwayView = z.object({
  active: z.boolean(),
  since: z.string().nullable(),
  settings: AwaySettings.nullable(),
  /** Reviews since the mode was last turned on, newest first (at most 100). */
  reviews: z.array(AwayReviewView),
  counts: z.object({ approved: z.number().int(), revised: z.number().int(), escalated: z.number().int() }),
  /** Why the approver cannot work right now (no API model), when that is so. */
  unavailable: z.string().nullable(),
});
export type AwayView = z.infer<typeof AwayView>;

export const SetAwayRequest = z.discriminatedUnion("enabled", [
  z.object({
    enabled: z.literal(true),
    /** The user saw the warning: turning the mode on needs an explicit yes. */
    confirm: z.literal(true),
    delegate: z.array(AwayDelegate).min(1).default(["plan", "pr"]),
    /** Minutes until it turns itself off; null never. */
    minutes: z.number().int().min(5).max(7 * 24 * 60).nullable().default(240),
    max_complexity: z.number().int().min(1).max(5).nullable().default(3),
    max_revisions: z.number().int().min(0).max(3).default(2),
  }),
  z.object({ enabled: z.literal(false) }),
]);
export type SetAwayRequest = z.infer<typeof SetAwayRequest>;
