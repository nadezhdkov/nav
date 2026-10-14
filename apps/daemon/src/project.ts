import { VerifyCommand } from "@navarch/contracts";
import { readFileAtCommit } from "@navarch/runner";
import { parse } from "yaml";
import { z } from "zod";

/**
 * Per-repository configuration, `.navarch/project.yaml` (spec §14.2). Only the keys this phase uses
 * are read. It is always read at the run's base commit, never from a worktree, so an agent cannot
 * change the commands that verify its own work.
 */
export const ProjectConfig = z.object({
  setup: z.array(z.string().min(1)).default([]),
  verify: z.array(VerifyCommand).default([]),
  allowlist: z.array(z.string().min(1)).default([]),
  protected_paths: z.array(z.string().min(1)).default([]),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

export const PROJECT_FILE = ".navarch/project.yaml";
/** Read when the repository has no `.navarch/project.yaml` yet (ADR 0008). */
export const LEGACY_PROJECT_FILE = ".vectr/project.yaml";

export async function loadProjectConfig(repoPath: string, commit: string): Promise<ProjectConfig> {
  let file = PROJECT_FILE;
  let text = await readFileAtCommit(repoPath, commit, file);
  if (text === undefined) {
    file = LEGACY_PROJECT_FILE;
    text = await readFileAtCommit(repoPath, commit, file);
  }
  if (text === undefined) return ProjectConfig.parse({});
  const parsed = ProjectConfig.safeParse(parse(text) ?? {});
  if (!parsed.success) throw new Error(`${file} at ${commit.slice(0, 10)} is invalid: ${parsed.error.message}`);
  return parsed.data;
}
