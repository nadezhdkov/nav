import { z } from "zod";

/** One `owner` or `name` segment of a GitHub repository: word characters, dots and dashes, but never `.` or `..`. */
const SEGMENT = String.raw`(?!\.\.?(?![\w.-]))[\w.-]+`;
/** `owner/name`, as a regular expression source (anchor it yourself). */
export const REPO_PATTERN = `${SEGMENT}/${SEGMENT}`;
export const ISSUE_REF = new RegExp(`^(${REPO_PATTERN})#(\\d+)$`);

/** Where a run's work came from (spec §4 WorkItem, §6.7): a GitHub issue, or a pull request (ADR 0032). */
export const WorkItemRef = z.object({
  source: z.literal("github"),
  /** Absent (an issue) before runs on pull requests. */
  kind: z.enum(["issue", "pull_request"]).optional(),
  /** `owner/name`. */
  repo: z.string().regex(new RegExp(`^${REPO_PATTERN}$`)),
  number: z.number().int().positive(),
  url: z.string().url(),
});
export type WorkItemRef = z.infer<typeof WorkItemRef>;

/** A failing check of a pull request's head commit, with the tail of its log (untrusted, redacted). */
export const FailingCheck = z.object({
  name: z.string(),
  conclusion: z.string(),
  url: z.string(),
  log_tail: z.string(),
});
export type FailingCheck = z.infer<typeof FailingCheck>;

/** What a run on a pull request knows about it (ADR 0032). */
export const PullRequestInfo = z.object({
  head_ref: z.string(),
  /** The head commit the run works on, as fetched into `refs/navarch/pr/<N>/head`. */
  head_sha: z.string(),
  /** `owner/name` of the head branch's repository: another one for a fork. */
  head_repo: z.string(),
  base_ref: z.string(),
  base_sha: z.string(),
  draft: z.boolean(),
  failing_checks: z.array(FailingCheck),
});
export type PullRequestInfo = z.infer<typeof PullRequestInfo>;

/** The issue or pull request as read from GitHub. Title and body are untrusted data, never instructions (T1). */
export const WorkItem = WorkItemRef.extend({
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  author: z.string(),
  /** Present for a pull request. */
  pull_request: PullRequestInfo.optional(),
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

/**
 * Isolation level L2 (spec §6.5.1, ADR 0035): the run's verify checks and setup commands run in a
 * container of this image instead of on the host. Resolved when the run is created.
 */
/** An image reference; it never starts with `-`, so the runtime cannot read it as a flag (`--privileged`). */
export const ContainerImage = z.string().regex(/^[a-z0-9][a-z0-9._/:@-]*$/i, "an image reference such as node:22-bookworm-slim");

export const ContainerIsolation = z.object({
  kind: z.literal("container"),
  image: ContainerImage,
  /** Container network of the verify checks; setup commands always get `bridge`. */
  network: z.enum(["none", "bridge"]),
  memory: z.string().regex(/^\d+[kmg]?$/i),
  cpus: z.number().positive(),
  pids_limit: z.number().int().positive(),
  /**
   * L3, the hardened level (ADR 0069): the agent itself runs in a container without a network interface,
   * reaching only its provider through an egress allowlist; `oci_runtime` names a stronger runtime (gVisor's `runsc`).
   */
  hardened: z
    .object({
      agent_image: ContainerImage,
      oci_runtime: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).optional(),
      /** Extra hosts the agent may reach over HTTPS, on top of its provider's. */
      egress_allow: z.array(z.string().regex(/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i)).default([]),
    })
    .optional(),
});
export type ContainerIsolation = z.infer<typeof ContainerIsolation>;

export const VerificationReport = z.object({
  checks: z.array(VerificationCheck),
  /** False when a required check failed. A run with no checks passes but is unverified (a warning). */
  passed: z.boolean(),
  blocking_failures: z.array(z.string()),
  warnings: z.array(z.string()),
  /** Where the checks ran; absent on the host (ADR 0035). */
  sandbox: z.object({ kind: z.literal("container"), image: z.string(), network: z.enum(["none", "bridge"]) }).optional(),
});
export type VerificationReport = z.infer<typeof VerificationReport>;
