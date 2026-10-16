import { z } from "zod";

/**
 * Documents the user attaches to a run (a spec, notes): small UTF-8 text files that every agent of
 * the run reads after its task. They live in `run.created`, never in the worktree, so they cannot
 * end up in the run's commit.
 */
export const ATTACHMENT_LIMITS = { files: 10, fileBytes: 100_000, totalBytes: 200_000 } as const;

const bytes = (s: string) => new TextEncoder().encode(s).length;

export const RunAttachment = z.object({
  /** A plain file name: letters, digits, spaces, `.`, `_` and `-`, no path. */
  name: z
    .string()
    .regex(/^[\p{L}\p{N}_-][\p{L}\p{N} ._-]{0,99}$/u, "a plain file name without a path")
    .refine((n) => !n.includes(".."), "a plain file name without a path"),
  content: z
    .string()
    .refine((c) => !c.includes("\u0000"), "only text files can be attached")
    .refine((c) => bytes(c) <= ATTACHMENT_LIMITS.fileBytes, `each attachment is at most ${ATTACHMENT_LIMITS.fileBytes / 1000} kB`),
});
export type RunAttachment = z.infer<typeof RunAttachment>;

export const RunAttachments = z
  .array(RunAttachment)
  .max(ATTACHMENT_LIMITS.files, `at most ${ATTACHMENT_LIMITS.files} attachments`)
  .refine((list) => new Set(list.map((a) => a.name)).size === list.length, "attachment names must be unique")
  .refine(
    (list) => list.reduce((n, a) => n + bytes(a.content), 0) <= ATTACHMENT_LIMITS.totalBytes,
    `attachments are at most ${ATTACHMENT_LIMITS.totalBytes / 1000} kB together`,
  );

/** What a run shows of an attachment. */
export const AttachmentInfo = z.object({ name: z.string(), bytes: z.number().int().nonnegative() });
export type AttachmentInfo = z.infer<typeof AttachmentInfo>;

export function attachmentInfo(a: RunAttachment): AttachmentInfo {
  return { name: a.name, bytes: bytes(a.content) };
}
