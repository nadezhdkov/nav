import { z } from "zod";

/** One `owner` or `name` segment of a GitHub repository: word characters, dots and dashes, but never `.` or `..`. */
const SEGMENT = String.raw`(?!\.\.?(?![\w.-]))[\w.-]+`;
/** `owner/name`, as a regular expression source (anchor it yourself). */
export const REPO_PATTERN = `${SEGMENT}/${SEGMENT}`;
export const ISSUE_REF = new RegExp(`^(${REPO_PATTERN})#(\\d+)$`);

/** Where a run's work came from (spec §4 WorkItem, §6.7). Phase 1 has GitHub issues only. */
export const WorkItemRef = z.object({
  source: z.literal("github"),
  /** `owner/name`. */
  repo: z.string().regex(new RegExp(`^${REPO_PATTERN}$`)),
  number: z.number().int().positive(),
  url: z.string().url(),
});
export type WorkItemRef = z.infer<typeof WorkItemRef>;

/** The issue as read from GitHub. Title and body are untrusted data, never instructions (T1). */
export const WorkItem = WorkItemRef.extend({
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  author: z.string(),
});
export type WorkItem = z.infer<typeof WorkItem>;

/** `owner/repo#42` → its parts, or undefined when the text is not an issue reference. */
export function parseIssueRef(text: string): { repo: string; number: number } | undefined {
  const m = ISSUE_REF.exec(text.trim());
  if (!m || Number(m[2]) < 1) return undefined;
  return { repo: m[1]!, number: Number(m[2]) };
}

/** A verify command from `.navarch/project.yaml` (spec §14.2). Checks are required unless marked otherwise. */
export const VerifyCommand = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  required: z.boolean().default(true),
});
export type VerifyCommand = z.infer<typeof VerifyCommand>;

/** One verification command and its result (spec §6.6). */
export const VerificationCheck = z.object({
  name: z.string(),
  command: z.string(),
  /** A failing required check fails the run; an optional one is a warning. */
  required: z.boolean(),
  /** Null when the command was killed (timeout or cancel). */
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().int().nonnegative(),
  /** Last output lines, redacted. */
  output_tail: z.string(),
});
export type VerificationCheck = z.infer<typeof VerificationCheck>;

export const VerificationReport = z.object({
  checks: z.array(VerificationCheck),
  /** False when a required check failed. A run with no checks passes but is unverified (a warning). */
  passed: z.boolean(),
  blocking_failures: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type VerificationReport = z.infer<typeof VerificationReport>;
