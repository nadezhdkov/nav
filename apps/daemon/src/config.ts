import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { AdapterId } from "@navarch/contracts";
import { z } from "zod";

/** An OpenAI-compatible endpoint for the native adapter. Keys are read from an environment variable, never stored here. */
const Provider = z.object({
  base_url: z.string().url(),
  /** Environment variable with the key; it wins over `api_key`. */
  api_key_env: z.string().optional(),
  /** The key in the Vault (ADR 0007), e.g. `secret://openrouter/api_key`, stored with `navarch secret set`. */
  api_key: z.string().regex(/^secret:\/\/[a-z0-9][a-z0-9/_.-]*$/).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  extra_body: z.record(z.string(), z.unknown()).optional(),
});
export type ProviderConfig = z.infer<typeof Provider>;

const defaultProviders: Record<string, ProviderConfig> = {
  ollama: { base_url: "http://127.0.0.1:11434/v1" },
  openrouter: {
    base_url: "https://openrouter.ai/api/v1",
    api_key_env: "OPENROUTER_API_KEY",
    api_key: "secret://openrouter/api_key",
    headers: { "X-Title": "Navarch" },
    extra_body: { usage: { include: true } },
  },
  /** OpenCode Zen (ADR 0014): OpenAI-compatible models, some of them free. */
  "opencode-zen": { base_url: "https://opencode.ai/inference/v1", api_key: "secret://opencode/api_key" },
};

const Tier = z.enum(["fast", "standard", "expert"]);

/** One catalog entry per CLI adapter, with the adapter's own default model. Model ids belong in config. */
const BUILTIN_MODELS = {
  "claude-code": { adapter: "claude-code", provider: "anthropic", status: "active" },
  copilot: { adapter: "copilot", provider: "github-copilot", status: "active" },
  opencode: { adapter: "opencode", provider: "opencode", status: "active" },
  codex: { adapter: "codex", provider: "openai", status: "active" },
  "gemini-cli": { adapter: "gemini-cli", provider: "google", status: "active" },
  antigravity: { adapter: "antigravity", provider: "google", status: "active" },
} satisfies Record<string, z.infer<typeof CatalogEntry>>;
const CatalogEntry = z.object({
  adapter: AdapterId,
  /** The adapter's model id; absent means the adapter's default. */
  model: z.string().optional(),
  provider: z.string(),
  status: z.enum(["active", "disabled"]).default("active"),
});

/**
 * Model Router v1 (spec §6.4, ADR 0013). The catalog lists adapter + model pairs the router may
 * use; prices and quotas are not in code. The defaults send triage and simple issues to Copilot
 * and the rest to Claude Code, each falling back to the other.
 */
const Routing = z
  .object({
    /** When false, runs use `default_adapter` as before. `--adapter`/`--model` always pin a run. */
    enabled: z.boolean().default(true),
    /** Added to (or replacing by id) the built-in entries, one per CLI adapter. */
    models: z
      .record(z.string(), CatalogEntry)
      .default({})
      .transform((models): Record<string, z.infer<typeof CatalogEntry>> => ({ ...BUILTIN_MODELS, ...models })),
    tiers: z
      .object({
        fast: z.array(z.string()).default(["copilot", "claude-code"]),
        standard: z.array(z.string()).default(["claude-code", "copilot"]),
        expert: z.array(z.string()).default(["claude-code", "copilot"]),
      })
      .prefault({}),
    profiles: z.record(z.string(), Tier).default({ triager: "fast", planner: "expert", implementer: "standard", reviewer: "standard", concierge: "fast" }),
    simple_max_complexity: z.number().int().min(0).max(5).default(2),
    different_provider: z.array(z.string()).default(["reviewer"]),
  })
  .prefault({});
export type RoutingConfig = z.infer<typeof Routing>;

/** Global configuration, `~/.navarch/config.yaml` (spec §14.1). Only Phase 0 keys are read. */
export const Config = z.object({
  daemon: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(0).max(65535).default(7420),
      /** The Web UI build to serve at `/` (ADR 0017); defaults to `apps/web/dist` in this checkout. */
      web_dir: z.string().optional(),
      /**
       * Remote access for the phone (ADR 0020): `tailscale serve` proxies the tailnet's HTTPS name to
       * this daemon. `url` is that origin; without it, it is read from `tailscale status --json`.
       */
      remote: z
        .object({
          mode: z.enum(["tailscale", "off"]).default("tailscale"),
          url: z.string().url().optional(),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Push notifications to paired devices (spec §6.11, ADR 0020). */
  notifications: z
    .object({
      web_push: z.boolean().default(true),
      /** Local time of the PC; only critical notifications are sent in between. */
      quiet_hours: z
        .object({
          start: z.string().regex(/^\d{2}:\d{2}$/),
          end: z.string().regex(/^\d{2}:\d{2}$/),
          allow_critical: z.boolean().default(true),
        })
        .optional(),
      /** Push services the daemon may POST to; a subscription elsewhere is refused. */
      push_hosts: z
        .array(z.string())
        .default(["fcm.googleapis.com", "updates.push.services.mozilla.com", "*.push.apple.com", "*.notify.windows.com"]),
      /** VAPID `sub` claim (RFC 8292): a mailto: or https: contact for the push services. */
      vapid_subject: z.string().default("https://github.com/nadezhdkov/nav"),
    })
    .prefault({}),
  budgets: z.object({ default_run: z.number().positive().default(2) }).prefault({}),
  /**
   * The conversational CLI's agent (ADR 0016). Without `model`, profile `concierge` is routed
   * among the `native` entries of its tier (`routing.profiles.concierge`, default fast).
   */
  concierge: z
    .object({
      enabled: z.boolean().default(true),
      /** `<provider>/<model>` of a native provider, e.g. `openrouter/nvidia/nemotron-3.5-lightning:free`. */
      model: z.string().optional(),
      /** Model calls per message. */
      max_steps: z.number().int().positive().default(8),
    })
    .prefault({}),
  scheduler: z
    .object({
      concurrency: z.number().int().positive().default(2),
      max_attempts: z.number().int().positive().default(3),
      task_timeout_minutes: z.number().positive().default(60),
      /** Waits after a rate limit when the agent did not say when its quota resets (last one repeats). */
      rate_limit_backoff_minutes: z.array(z.number().positive()).nonempty().default([1, 5, 15, 60]),
      /** Rate-limit waits per task before the run is paused; they do not count as attempts. */
      rate_limit_max_waits: z.number().int().nonnegative().default(8),
      /** Longest automatic wait for a quota reset; a later reset pauses the run (`navarch run resume`). */
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
  routing: Routing,
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
      copilot: z
        .object({ enabled: z.boolean().default(true), command: z.string().default("copilot"), model: z.string().optional() })
        .prefault({}),
      /** OpenCode CLI (ADR 0015); the installer puts it in ~/.opencode/bin, which may not be on PATH. */
      opencode: z
        .object({ enabled: z.boolean().default(true), command: z.string().default("opencode"), model: z.string().optional() })
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

/**
 * The daemon's home. A home from before the rename (ADR 0008), `VECTR_HOME` or an existing
 * `~/.vectr`, keeps working in place: its worktrees are registered in the operators' repositories
 * under their absolute paths, so moving the directory would break them.
 */
export function navarchHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.NAVARCH_HOME) return env.NAVARCH_HOME;
  if (env.VECTR_HOME) return env.VECTR_HOME;
  const current = join(home, ".navarch");
  const legacy = join(home, ".vectr");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

/** File names inside a home; a home created before the rename keeps its old names. */
export function homeFiles(home: string): { db: string; daemonInfo: string; daemonLog: string } {
  const legacy = existsSync(join(home, "vectr.db")) && !existsSync(join(home, "navarch.db"));
  const prefix = legacy ? "vectr" : "navarch";
  return { db: join(home, `${prefix}.db`), daemonInfo: join(home, `${prefix}d.json`), daemonLog: join(home, `${prefix}d.log`) };
}

export function loadConfig(home: string): Config {
  const file = join(home, "config.yaml");
  const raw = existsSync(file) ? (parse(readFileSync(file, "utf8")) ?? {}) : {};
  return Config.parse(raw);
}
