import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { AdapterId } from "@vectr/contracts";
import { z } from "zod";

/** An OpenAI-compatible endpoint for the native adapter. Keys are read from an environment variable, never stored here. */
const Provider = z.object({
  base_url: z.string().url(),
  api_key_env: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  extra_body: z.record(z.string(), z.unknown()).optional(),
});
export type ProviderConfig = z.infer<typeof Provider>;

const defaultProviders: Record<string, ProviderConfig> = {
  ollama: { base_url: "http://127.0.0.1:11434/v1" },
  openrouter: {
    base_url: "https://openrouter.ai/api/v1",
    api_key_env: "OPENROUTER_API_KEY",
    headers: { "X-Title": "VECTR" },
    extra_body: { usage: { include: true } },
  },
};

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
      /** Waits after a rate limit when the agent did not say when its quota resets (last one repeats). */
      rate_limit_backoff_minutes: z.array(z.number().positive()).nonempty().default([1, 5, 15, 60]),
      /** Rate-limit waits per task before the run is paused; they do not count as attempts. */
      rate_limit_max_waits: z.number().int().nonnegative().default(8),
      /** Longest automatic wait for a quota reset; a later reset pauses the run (`vectr run resume`). */
      rate_limit_max_wait_hours: z.number().positive().default(12),
    })
    .prefault({}),
  autonomy_level: z.number().int().min(0).max(4).default(2),
  /** GitHub Integration (spec §6.7). The token is `secret://github/token` in the Vault (ADR 0007), never here. */
  github: z
    .object({
      api_url: z.string().url().default("https://api.github.com"),
      /** Base for push URLs (`<git_url>/<owner>/<name>.git`); tests use a local directory of bare repositories. */
      git_url: z.string().default("https://github.com"),
    })
    .prefault({}),
  allow_commands: z.array(z.string()).default([]),
  /** Adapter used when a run does not choose one. */
  default_adapter: AdapterId.default("claude-code"),
  adapters: z
    .object({
      "claude-code": z
        .object({
          enabled: z.boolean().default(true),
          command: z.string().default("claude"),
          permission_mode: z.string().default("acceptEdits"),
          /** Claude Code settings to load; `user` is left out so the operator's ~/.claude does not steer tasks. */
          setting_sources: z.string().default("project,local"),
          model: z.string().optional(),
        })
        .prefault({}),
      "gemini-cli": z
        .object({ enabled: z.boolean().default(true), command: z.string().default("gemini"), model: z.string().optional() })
        .prefault({}),
      antigravity: z
        .object({ enabled: z.boolean().default(true), command: z.string().default("agy"), model: z.string().optional() })
        .prefault({}),
      codex: z
        .object({ enabled: z.boolean().default(true), command: z.string().default("codex"), model: z.string().optional() })
        .prefault({}),
      native: z
        .object({
          enabled: z.boolean().default(true),
          /** `<provider>/<model>`, e.g. `ollama/qwen2.5:7b` or `openrouter/qwen/qwen3-coder:free`. */
          model: z.string().optional(),
          max_turns: z.number().int().positive().default(40),
          providers: z.record(z.string(), Provider).default(defaultProviders),
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
