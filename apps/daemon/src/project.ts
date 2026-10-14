import { VerifyCommand } from "@vectr/contracts";
import { readFileAtCommit } from "@vectr/runner";
import { parse } from "yaml";
import { z } from "zod";

/**
 * Per-repository configuration, `.vectr/project.yaml` (spec §14.2). Only the keys this phase uses
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

export const PROJECT_FILE = ".vectr/project.yaml";

export async function loadProjectConfig(repoPath: string, commit: string): Promise<ProjectConfig> {
  const text = await readFileAtCommit(repoPath, commit, PROJECT_FILE);
  if (text === undefined) return ProjectConfig.parse({});
  const parsed = ProjectConfig.safeParse(parse(text) ?? {});
  if (!parsed.success) throw new Error(`${PROJECT_FILE} at ${commit.slice(0, 10)} is invalid: ${parsed.error.message}`);
  return parsed.data;
}
