import { z } from "zod";

/**
 * Compete mode (ADR 0031): N competitors implement the same task in their own worktrees, a judge
 * ranks the ones whose checks passed (the finalists), and the winner is merged into the run's
 * worktree. The judge ends its answer with a fenced `navarch-judge` block.
 */

export const JudgeRank = z.strictObject({
  competitor: z.string().min(1).max(32),
  score: z.number().min(0).max(10),
  reason: z.string().trim().min(1).max(2_000),
});
export type JudgeRank = z.infer<typeof JudgeRank>;

export const JudgeVerdict = z.strictObject({
  summary: z.string().trim().min(1).max(4_000),
  /** Every finalist once, best first. */
  ranking: z.array(JudgeRank).min(1).max(5),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

/** Which part of a compete node a task is. */
export const CompeteTaskRole = z.enum(["competitor", "verify", "compare", "judge", "approval", "adopt"]);
export type CompeteTaskRole = z.infer<typeof CompeteTaskRole>;

export const CompeteTaskRef = z.object({
  node_id: z.string(),
  role: CompeteTaskRole,
  /** Competitor key (`c1`…), for competitors and their checks. */
  key: z.string().optional(),
});
export type CompeteTaskRef = z.infer<typeof CompeteTaskRef>;

const BLOCK = /```navarch-judge[ \t]*\r?\n([\s\S]*?)```/g;

/** Reads the last `navarch-judge` block of a judge's answer; the ranking must name every finalist once. */
export function parseJudgeVerdict(text: string, finalists: readonly string[]): { ok: true; verdict: JudgeVerdict } | { ok: false; error: string } {
  const raw = [...text.matchAll(BLOCK)].at(-1)?.[1];
  if (raw === undefined) return { ok: false, error: "no ```navarch-judge block at the end of the answer" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `the navarch-judge block is not valid JSON: ${(err as Error).message}` };
  }
  const parsed = JudgeVerdict.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { ok: false, error: `navarch-judge ${issue.path.join(".") || "verdict"}: ${issue.message}` };
  }
  const seen = new Set<string>();
  for (const r of parsed.data.ranking) {
    if (!finalists.includes(r.competitor)) return { ok: false, error: `${r.competitor} is not a finalist (finalists: ${finalists.join(", ")})` };
    if (seen.has(r.competitor)) return { ok: false, error: `${r.competitor} is ranked twice` };
    seen.add(r.competitor);
  }
  const missing = finalists.filter((f) => !seen.has(f));
  if (missing.length) return { ok: false, error: `the ranking leaves out ${missing.join(", ")}; rank every finalist: ${finalists.join(", ")}` };
  return { ok: true, verdict: parsed.data };
}
