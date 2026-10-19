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

export const PrinciplesView = z.object({
  project_id: z.string(),
  principles: z.array(PrincipleView),
  /** Rules cut from the file for being too many or too long (see `MAX_PRINCIPLES`). */
  truncated: z.boolean(),
});
export type PrinciplesView = z.infer<typeof PrinciplesView>;

export const AddPrincipleRequest = z.object({ text: PrincipleText, run_id: z.string().optional() });
export type AddPrincipleRequest = z.infer<typeof AddPrincipleRequest>;

/** At most this many rules reach an agent's prompt, the user's first. */
export const MAX_PRINCIPLES = 30;
