import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/** Global configuration, `~/.vectr/config.yaml` (spec §14.1). Only Phase 0 keys are read. */
export const Config = z.object({
  daemon: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(0).max(65535).default(7420),
    })
    .prefault({}),
  budgets: z.object({ default_run: z.number().positive().default(2) }).prefault({}),
  scheduler: z
    .object({
      concurrency: z.number().int().positive().default(2),
      max_attempts: z.number().int().positive().default(3),
      task_timeout_minutes: z.number().positive().default(60),
    })
    .prefault({}),
  autonomy_level: z.number().int().min(0).max(4).default(2),
  allow_commands: z.array(z.string()).default([]),
  adapters: z
    .object({
      "claude-code": z
        .object({
          command: z.string().default("claude"),
          permission_mode: z.string().default("acceptEdits"),
          model: z.string().optional(),
        })
        .prefault({}),
    })
    .prefault({}),
});
export type Config = z.infer<typeof Config>;

export function vectrHome(): string {
  return process.env.VECTR_HOME ?? join(homedir(), ".vectr");
}

export function loadConfig(home: string): Config {
  const file = join(home, "config.yaml");
  const raw = existsSync(file) ? (parse(readFileSync(file, "utf8")) ?? {}) : {};
  return Config.parse(raw);
}
