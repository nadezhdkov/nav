import { z } from "zod";

/** Opt-in auto-merge, per repository (spec §11.1, ADR 0060). */

export const AutoMergeStrategy = z.enum(["squash", "merge", "rebase"]);
export type AutoMergeStrategy = z.infer<typeof AutoMergeStrategy>;

/** What the user is told before turning it on, and what every merge is checked against. */
export const AUTO_MERGE_CONDITIONS: readonly string[] = [
  "the run's autonomy level is 3 or higher",
  "the PR is the run's own (a `navarch/*` branch of this repository) and targets the default branch, which must not be protected on GitHub",
  "the PR head is the commit Navarch pushed, and GitHub shows at least one check run, all finished and green",
  "the Navarch verification passed with checks configured, and no protected path changed",
  "the reviewer, from another provider, approved with no blocking finding and no 🔴 item",
  "no file in a dependency manifest, a lockfile or `.github/workflows/` changed, and no `protected_paths` entry matched",
  "the run's billed cost is within its budget",
];

export const AutoMergeView = z.object({
  project_id: z.string(),
  repo: z.string(),
  enabled: z.boolean(),
  strategy: AutoMergeStrategy,
  /** When the user turned it on, if it is on. */
  since: z.string().nullable(),
  /** Why each open PR of Navarch's was not merged at its last check, newest first. */
  waiting: z.array(z.object({ number: z.number().int().positive(), url: z.string(), reason: z.string() })),
});
export type AutoMergeView = z.infer<typeof AutoMergeView>;

export const AutoMergeStatus = z.object({ conditions: z.array(z.string()), projects: z.array(AutoMergeView) });
export type AutoMergeStatus = z.infer<typeof AutoMergeStatus>;

export const SetAutoMergeRequest = z.object({
  enabled: z.boolean(),
  /** To turn it on: the repository's `owner/name`, typed by the user after reading the conditions. */
  confirm: z.string().optional(),
  strategy: AutoMergeStrategy.optional(),
  /** A single-use token from a security key (WebAuthn), needed to turn it on when the user has registered one (ADR 0062). */
  reauth: z.string().optional(),
});
export type SetAutoMergeRequest = z.infer<typeof SetAutoMergeRequest>;
