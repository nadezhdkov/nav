import { z } from "zod";

/** CI failures noticed on open pull requests by polling (ADR 0041). */

export const CiFailureStatus = z.enum(["open", "started", "dismissed", "resolved"]);
export type CiFailureStatus = z.infer<typeof CiFailureStatus>;

export const CiFailureView = z.object({
  id: z.string(),
  project_id: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string(),
  url: z.string(),
  head_ref: z.string(),
  head_sha: z.string(),
  checks: z.array(z.object({ name: z.string(), conclusion: z.string(), url: z.string() })),
  status: CiFailureStatus,
  detected_at: z.string(),
  /** The `ci-fix` run, once started. */
  run_id: z.string().nullable(),
  resolved_reason: z.enum(["closed", "moved", "passed"]).nullable(),
});
export type CiFailureView = z.infer<typeof CiFailureView>;

export const FixCiFailureRequest = z.strictObject({ budget: z.number().positive().optional() });
export type FixCiFailureRequest = z.infer<typeof FixCiFailureRequest>;
