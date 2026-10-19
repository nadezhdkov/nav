import { ContainerImage, VerifyCommand, type ContainerIsolation } from "@navarch/contracts";
import type { Config } from "./config.ts";
import { readFileAtCommit } from "@navarch/runner";
import { parse } from "yaml";
import { z } from "zod";

/**
 * Per-repository configuration, `.navarch/project.yaml` (spec §14.2). Only the keys this phase uses
 * are read. It is always read at the run's base commit, never from a worktree, so an agent cannot
 * change the commands that verify its own work.
 */
export const ProjectConfig = z.object({
  /** Spec §11; overrides the daemon's `autonomy_level` for runs on this repository. */
  autonomy_level: z.number().int().min(0).max(4).optional(),
  setup: z.array(z.string().min(1)).default([]),
  verify: z.array(VerifyCommand).default([]),
  allowlist: z.array(z.string().min(1)).default([]),
  protected_paths: z.array(z.string().min(1)).default([]),
  /** Spec §14.2: `container` runs the verify checks and setup commands in a container (L2, ADR 0035). */
  isolation: z.enum(["worktree", "container", "hardened"]).optional(),
  /** Overrides the daemon's `container` defaults; `network` is the verify checks' (setup always has one). */
  container: z
    .object({
      image: ContainerImage.optional(),
      network: z.enum(["none", "bridge"]).default("none"),
      memory: z.string().regex(/^\d+[kmg]?$/i).optional(),
      cpus: z.number().positive().optional(),
    })
    .prefault({}),
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

/** The run's isolation, resolved once at creation: undefined runs on the host (L1). */
export function resolveIsolation(project: ProjectConfig, config: Pick<Config, "security" | "container">): ContainerIsolation | undefined {
  const level = project.isolation ?? config.security.default_isolation;
  // A repository cannot lower what the operator set for every project: hardened by default stays hardened.
  const hardened = level === "hardened" || config.security.default_isolation === "hardened";
  if (level !== "container" && !hardened) return undefined;
  const c = project.container;
  return {
    kind: "container",
    image: c.image ?? config.container.image,
    // L3 has no network for checks; the project's `network: bridge` is for L2 only.
    network: hardened ? "none" : c.network,
    memory: c.memory ?? config.container.memory,
    cpus: c.cpus ?? config.container.cpus,
    pids_limit: config.container.pids_limit,
    ...(hardened
      ? { hardened: { agent_image: config.container.agent_image, ...(config.container.oci_runtime ? { oci_runtime: config.container.oci_runtime } : {}), egress_allow: config.container.egress_allow } }
      : {}),
  };
}
