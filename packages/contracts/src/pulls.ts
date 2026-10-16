import { z } from "zod";

/**
 * Runs on pull requests (ADR 0032): the `review-pr` reviewer's draft review, and the outputs any
 * agent may declare at the end of its answer.
 */

export const ReviewComment = z.strictObject({
  path: z.string().trim().min(1).max(500),
  /** A line of the file's new version. */
  line: z.number().int().positive(),
  body: z.string().trim().min(1).max(4_000),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

export const ReviewDraft = z.strictObject({
  summary: z.string().trim().min(1).max(8_000),
  /** The reviewer's opinion; Navarch always posts it as a comment, never as an approval. */
  verdict: z.enum(["comment", "approve", "request_changes"]),
  comments: z.array(ReviewComment).max(30).default([]),
});
export type ReviewDraft = z.infer<typeof ReviewDraft>;

const REVIEW_BLOCK = /```navarch-review[ \t]*\r?\n([\s\S]*?)```/g;

/** Reads the last `navarch-review` block of a reviewer's answer. */
export function parseReviewDraft(text: string): { ok: true; review: ReviewDraft } | { ok: false; error: string } {
  const raw = [...text.matchAll(REVIEW_BLOCK)].at(-1)?.[1];
  if (raw === undefined) return { ok: false, error: "no ```navarch-review block at the end of the answer" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `the navarch-review block is not valid JSON: ${(err as Error).message}` };
  }
  const parsed = ReviewDraft.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { ok: false, error: `navarch-review ${issue.path.join(".") || "review"}: ${issue.message}` };
  }
  return { ok: true, review: parsed.data };
}

const OUTPUTS_BLOCK = /```navarch-outputs[ \t]*\r?\n([\s\S]*?)```/g;

/**
 * The scalar fields of the last fenced `navarch-outputs` JSON object of an agent's answer, which
 * become task outputs (ADR 0032). Anything else (no block, invalid JSON, nested values, `summary`)
 * is left out.
 */
export function parseDeclaredOutputs(text: string): Record<string, string | number | boolean> {
  const raw = [...text.matchAll(OUTPUTS_BLOCK)].at(-1)?.[1];
  if (raw === undefined) return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(json)) {
    if (key === "summary" || !/^[a-z][a-z0-9_]{0,63}$/.test(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, 4_000);
    else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
  }
  return out;
}
