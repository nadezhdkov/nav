import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { AdapterId, ContainerImage } from "@navarch/contracts";
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
  /** Kilo's gateway picks a free model for each request; no account needed. In no tier by default (ADR 0034). */
  kilo: { adapter: "kilo", model: "kilo/kilo-auto/free", provider: "kilo", status: "active" },
  grok: { adapter: "grok", provider: "xai", status: "active" },
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
 * use; prices and quotas are not in code. The defaults send triage and simple issues to Grok (free
 * with a grok.com sign-in, ADR 0024), then Copilot, and the rest to Claude Code, falling back to
 * Copilot. Kilo's free models (ADR 0034) are in the catalog but in no tier: their providers may
 * log prompts, so the operator adds `kilo` to a tier on purpose.
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
        fast: z.array(z.string()).default(["grok", "copilot", "claude-code"]),
        standard: z.array(z.string()).default(["claude-code", "copilot"]),
        expert: z.array(z.string()).default(["claude-code", "copilot"]),
      })
      .prefault({}),
    profiles: z.record(z.string(), Tier).default({ triager: "fast", planner: "expert", implementer: "standard", architecture: "expert", frontend: "standard", backend: "standard", devops: "standard", qa: "standard", reviewer: "standard", concierge: "fast", inbox: "fast", approver: "standard", lead: "expert", sublead: "expert", researcher: "fast", judge: "expert", "pr-reviewer": "standard", "ci-fixer": "standard", "spec-scout": "standard", "spec-writer": "standard", "spec-syncer": "standard" }),
    simple_max_complexity: z.number().int().min(0).max(5).default(2),
    different_provider: z.array(z.string()).default(["reviewer", "judge"]),
    /** A candidate whose quota window is at least this used goes after the others in its tier (ADR 0023). */
    quota_reserve: z.number().min(0).max(1).default(0.9),
    /** A candidate with at least 4 tasks in 24 h failing at this rate or more goes after the others. */
    degraded_error_rate: z.number().min(0).max(1).default(0.5),
    /**
     * After a rate limit with no reset time (Grok's free limit), the agent is treated as exhausted
     * for this long, so routing skips it instead of trying it first on every task.
     */
    rate_limit_cooldown_minutes: z.number().positive().default(30),
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
          mode: z.enum(["tailscale", "relay", "off"]).default("tailscale"),
          url: z.string().url().optional(),
          /** The relay to dial out to when `mode` is `relay` (ADR 0066), e.g. `https://relay.example.com`. */
          relay_url: z.string().url().optional(),
          /** The Tailscale CLI, read-only (`status`, `serve status`); tests point it at a fake. */
          tailscale_command: z.string().default("tailscale"),
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
  /**
   * Budgets in USD (spec §6.1.4, ADR 0023). Only billed (`metered`) use counts; plan use is bounded
   * by quotas. Periods use the PC's local time. `navarch budget set` overrides these.
   */
  budgets: z
    .object({
      default_run: z.number().positive().default(2),
      /** Per registered project and local day; none by default. */
      project_daily: z.number().positive().nullable().default(null),
      /** Across everything, per local calendar month. */
      global_monthly: z.number().positive().nullable().default(100),
      /** Share of a limit that records `budget.threshold` and notifies, before the one at 100 %. */
      alert_threshold: z.number().gt(0).lt(1).default(0.8),
    })
    .prefault({}),
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
  /**
   * The Inbox (ADR 0021): GitHub polling of registered projects and triage of new items on an API
   * model. Without `model`, profile `inbox` is routed among the `native` entries of its tier.
   */
  inbox: z
    .object({
      /** Minutes between syncs of each project; 0 turns polling off (`navarch sync` still works). */
      poll_minutes: z.number().nonnegative().default(15),
      /** `<provider>/<model>` of a native provider. */
      model: z.string().optional(),
      triage: z
        .object({
          enabled: z.boolean().default(true),
          /** Per day in the PC's local time; the Policy Engine denies triage beyond either cap. */
          daily_items: z.number().int().nonnegative().default(50),
          daily_usd: z.number().nonnegative().default(0.5),
        })
        .prefault({}),
    })
    .prefault({}),
  /**
   * The Knowledge Engine (ADR 0043). `context.enabled` puts a compiled context block in the prompts
   * of triager, planner, implementer, researcher and lead tasks; off until the go/no-go measures it.
   */
  knowledge: z
    .object({
      context: z
        .object({
          enabled: z.boolean().default(false),
          max_tokens: z.number().int().positive().default(4_000),
          /** `lean` (ADR 0070) puts only the few files to open first in the prompt, in `lean_max_tokens`; `full` is ADR 0043's block. */
          mode: z.enum(["full", "lean"]).default("full"),
          lean_max_tokens: z.number().int().positive().default(600),
          /** Profiles whose prompt carries it; empty means every profile of ADR 0043. The triager is cheap without it. */
          profiles: z.array(z.string()).default([]),
          /** A triaged run below this complexity gets no block: on small tasks the block costs more than it saves. */
          min_complexity: z.number().int().min(1).max(5).default(1),
        })
        .prefault({}),
    })
    .prefault({}),
  /**
   * CI failures noticed on open pull requests (ADR 0041). With `auto`, the daemon starts a `ci-fix`
   * run itself, at most `daily_runs` a day in the PC's local time; otherwise the user starts it.
   */
  ci_fix: z
    .object({
      auto: z.boolean().default(false),
      daily_runs: z.number().int().nonnegative().default(3),
    })
    .prefault({}),
  /**
   * Scheduled runs (spec §7.4, UC-14, ADR 0064): runs the user set on a timetable. The daemon starts
   * at most `daily_runs` of them a day (the PC's local time); a slot missed by more than
   * `grace_minutes` (the daemon was off) is skipped, never started late.
   */
  schedules: z
    .object({
      enabled: z.boolean().default(true),
      daily_runs: z.number().int().nonnegative().default(5),
      grace_minutes: z.number().int().min(0).max(720).default(30),
    })
    .prefault({}),
  /**
   * The morning summary (spec §7.4, ADR 0059). With `enabled`, once a day at `at` (the PC's local
   * time) the daemon syncs every project, builds the summary and sends a notification.
   */
  summary: z
    .object({
      enabled: z.boolean().default(false),
      at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("08:00"),
      /** A draft PR of Navarch's open this many days is listed as stalled. */
      stalled_days: z.number().int().positive().default(3),
    })
    .prefault({}),
  /**
   * `spec-sync` after merges (ADR 0052). With `auto`, the daemon starts it itself for a pull request
   * Navarch opened that was merged, in a project that already has specs, at most `daily_runs` a day
   * in the PC's local time; otherwise the user starts it.
   */
  spec_sync: z
    .object({
      auto: z.boolean().default(false),
      daily_runs: z.number().int().nonnegative().default(3),
    })
    .prefault({}),
  /**
   * Away mode (ADR 0039): the approver reads approvals for the user while they are away. Without
   * `model`, profile `approver` is routed among the `native` entries of its tier.
   */
  away: z
    .object({
      /** `<provider>/<model>` of a native provider. */
      model: z.string().optional(),
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
  /** Spec §14.1 `security`: the isolation of projects whose `.navarch/project.yaml` does not choose one (ADR 0035). */
  security: z.object({ default_isolation: z.enum(["worktree", "container", "hardened"]).default("worktree") }).prefault({}),
  /** Isolation level L2 (spec §6.5.1, ADR 0035): defaults for projects that run their checks in a container. */
  container: z
    .object({
      /** The runtime's command; podman takes the same flags. */
      runtime: z.string().min(1).default("docker"),
      image: ContainerImage.default("node:22-bookworm-slim"),
      memory: z.string().regex(/^\d+[kmg]?$/i).default("4g"),
      cpus: z.number().positive().default(2),
      pids_limit: z.number().int().positive().default(1024),
      /** L3 (ADR 0069): the image agents run in; it needs Node and the agent CLIs (`make agent-image`). Never taken from a repository. */
      agent_image: ContainerImage.default("navarch-agent:latest"),
      /** L3: a stronger OCI runtime for every container of a hardened run, e.g. gVisor's `runsc`. */
      oci_runtime: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).optional(),
      /** L3: hosts agents may reach over HTTPS besides their provider's (`*.example.com` allows subdomains). */
      egress_allow: z.array(z.string().regex(/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i)).default([]),
    })
    .prefault({}),
  /**
   * Where projects live (ADR 0073), e.g. `~/Documents/projects`. New and cloned repositories go to
   * `<root>/<name>`; unset, they stay in the Navarch home. Not read from a repository.
   */
  workspace: z
    .object({ root: z.string().regex(/^(~\/|\/)/, "an absolute path, or one starting with ~/").optional() })
    .prefault({}),
  /**
   * Live Claude Code sessions from the Web UI or a paired phone (ADR 0074). Off until the user turns it on
   * here, on the PC: a phone cannot enable what lets it run commands on the PC.
   */
  sessions: z
    .object({
      enabled: z.boolean().default(false),
      /** Sessions open at once. */
      max_open: z.number().int().positive().default(2),
      /** A session with no message or answer for this long is closed. */
      idle_minutes: z.number().int().positive().default(30),
      /** `--max-budget-usd` for each session's Claude Code, a ceiling when the login turns out to be an API key. */
      max_cost_usd: z.number().positive().default(5),
      /** What the agent may do without asking: `default` asks for edits and commands, `acceptEdits` only for commands. */
      permission_mode: z.enum(["default", "acceptEdits"]).default("default"),
      /** Claude Code settings to load. A session is the operator's own, so `user` (their `~/.claude`) is included. */
      setting_sources: z.string().default("user,project,local"),
    })
    .prefault({}),
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
      /** Kilo CLI (ADR 0034); without `command`, `kilo` on PATH, else ~/.kilo/bin/kilo where the installer puts it. */
      kilo: z
        .object({
          enabled: z.boolean().default(true),
          command: z.string().optional(),
          /** For runs pinned with `--adapter kilo`; Kilo's own default may be a paid model. */
          model: z.string().default("kilo/kilo-auto/free"),
        })
        .prefault({}),
      /** Grok CLI (ADR 0024), signed in with `grok login`. */
      grok: z
        .object({ enabled: z.boolean().default(true), command: z.string().default("grok"), model: z.string().optional() })
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
