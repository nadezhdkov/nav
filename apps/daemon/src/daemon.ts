import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AntigravityAdapter, type AntigravityOptions } from "@vectr/adapter-antigravity";
import { ClaudeCodeAdapter, type ClaudeCodeOptions } from "@vectr/adapter-claude-code";
import { CodexAdapter, type CodexOptions } from "@vectr/adapter-codex";
import { GeminiCliAdapter, type GeminiCliOptions } from "@vectr/adapter-gemini-cli";
import { NativeAdapter, type NativeOptions, type Provider } from "@vectr/adapter-native";
import { AgentRuntime } from "@vectr/agent-runtime";
import { registerSecret, type AdapterId, type AgentAdapter } from "@vectr/contracts";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./api/server.ts";
import { loadConfig, type Config } from "./config.ts";
import { EventStore } from "./events/store.ts";
import { Orchestrator } from "./orchestrator/orchestrator.ts";
import { PolicyEngine } from "./policy/engine.ts";
import { Scheduler } from "./scheduler/scheduler.ts";

export type DaemonOptions = {
  home: string;
  config?: Config;
  /** Per-adapter overrides (tests point them at fake CLIs or a fake model server). */
  adapters?: {
    "claude-code"?: ClaudeCodeOptions;
    "gemini-cli"?: GeminiCliOptions;
    antigravity?: AntigravityOptions;
    codex?: CodexOptions;
    native?: Partial<NativeOptions>;
  };
  port?: number;
};

type LogListener = (runId: string, taskId: string, line: string) => void;

/** `vectrd`: wires the event store, policy, orchestrator, scheduler, runtime and API. */
export class Daemon {
  readonly home: string;
  readonly config: Config;
  readonly store: EventStore;
  readonly orchestrator: Orchestrator;
  readonly scheduler: Scheduler;
  readonly adapters: Map<string, AgentAdapter>;
  private readonly logListeners = new Set<LogListener>();
  private server?: FastifyInstance;
  private port?: number;

  constructor(options: DaemonOptions) {
    this.home = options.home;
    for (const dir of ["logs", "artifacts", "worktrees"]) mkdirSync(join(this.home, dir), { recursive: true });
    this.config = options.config ?? loadConfig(this.home);
    if (options.port !== undefined) this.config.daemon.port = options.port;

    this.store = new EventStore(join(this.home, "vectr.db"));
    this.adapters = buildAdapters(this.config, options.adapters ?? {}, this.home);
    const adapters = this.adapters;
    const runtime = new AgentRuntime({
      home: this.home,
      adapters,
      publish: (event) => this.store.append([event]),
      onLog: (runId, taskId, line) => {
        for (const listener of this.logListeners) listener(runId, taskId, line);
      },
    });
    const policy = new PolicyEngine();
    this.scheduler = new Scheduler({
      store: this.store,
      runtime,
      policy,
      config: this.config,
      cancel: async (taskId) => {
        await Promise.all([...adapters.values()].map((a) => a.cancel(taskId)));
      },
    });
    this.orchestrator = new Orchestrator(this.store, this.config, [...adapters.keys()], () => this.scheduler.pump());
  }

  get url(): string {
    return `http://${this.config.daemon.host}:${this.port ?? this.config.daemon.port}`;
  }

  onLog(listener: LogListener): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  async start(): Promise<void> {
    const token = ensureToken(this.home);
    this.server = await buildServer(this, token);
    await this.server.listen({ host: this.config.daemon.host, port: this.config.daemon.port });
    const address = this.server.server.address();
    this.port = typeof address === "object" && address ? address.port : this.config.daemon.port;
    writeFileSync(join(this.home, "vectrd.json"), JSON.stringify({ pid: process.pid, url: this.url }));
    this.orchestrator.recover();
    this.scheduler.pump();
  }

  /**
   * Stops the API and kills agent subprocesses without recording an outcome: running tasks stay
   * `running` in the log and are requeued as `interrupted` on the next start.
   */
  async stop(): Promise<void> {
    await this.server?.close();
    await this.scheduler.stop(async () => {
      await Promise.all([...this.adapters.values()].map((a) => a.stopAll()));
    });
    this.store.close();
    rmSync(join(this.home, "vectrd.json"), { force: true });
  }
}

/** Enabled adapters, keyed by id. Provider API keys are read from the environment and registered for redaction. */
export function buildAdapters(
  config: Config,
  overrides: NonNullable<DaemonOptions["adapters"]>,
  home: string,
): Map<string, AgentAdapter> {
  const a = config.adapters;
  const all: [AdapterId, boolean, () => AgentAdapter][] = [
    [
      "claude-code",
      a["claude-code"].enabled,
      () =>
        new ClaudeCodeAdapter({
          command: a["claude-code"].command,
          permissionMode: a["claude-code"].permission_mode,
          settingSources: a["claude-code"].setting_sources,
          ...overrides["claude-code"],
        }),
    ],
    [
      "gemini-cli",
      a["gemini-cli"].enabled,
      () => new GeminiCliAdapter({ command: a["gemini-cli"].command, homeRoot: join(home, "agents", "gemini-cli"), ...overrides["gemini-cli"] }),
    ],
    [
      "antigravity",
      a.antigravity.enabled,
      () => new AntigravityAdapter({ command: a.antigravity.command, homeRoot: join(home, "agents", "antigravity"), ...overrides.antigravity }),
    ],
    ["codex", a.codex.enabled, () => new CodexAdapter({ command: a.codex.command, ...overrides.codex })],
    [
      "native",
      a.native.enabled,
      () => {
        const providers: Record<string, Provider> = {};
        for (const [name, p] of Object.entries(a.native.providers)) {
          const apiKey = p.api_key_env ? process.env[p.api_key_env] : undefined;
          if (apiKey) registerSecret(apiKey);
          providers[name] = {
            baseUrl: p.base_url,
            ...(apiKey ? { apiKey } : {}),
            ...(p.headers ? { headers: p.headers } : {}),
            ...(p.extra_body ? { extraBody: p.extra_body } : {}),
          };
        }
        return new NativeAdapter({
          providers,
          maxTurns: a.native.max_turns,
          ...(a.native.model ? { defaultModel: a.native.model } : {}),
          ...overrides.native,
        });
      },
    ],
  ];
  return new Map(all.filter(([, enabled]) => enabled).map(([id, , make]) => [id, make()]));
}

export function ensureToken(home: string): string {
  const file = join(home, "token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const token = randomBytes(32).toString("base64url");
  writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}
