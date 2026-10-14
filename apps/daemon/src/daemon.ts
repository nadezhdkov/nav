import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeAdapter, type ClaudeCodeOptions } from "@vectr/adapter-claude-code";
import { AgentRuntime } from "@vectr/agent-runtime";
import type { AgentAdapter } from "@vectr/contracts";
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
  /** Overrides for the Claude Code adapter (tests point it at a fake CLI). */
  claudeCode?: ClaudeCodeOptions;
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
  private readonly adapter: ClaudeCodeAdapter;
  private readonly logListeners = new Set<LogListener>();
  private server?: FastifyInstance;
  private port?: number;

  constructor(options: DaemonOptions) {
    this.home = options.home;
    for (const dir of ["logs", "artifacts", "worktrees"]) mkdirSync(join(this.home, dir), { recursive: true });
    this.config = options.config ?? loadConfig(this.home);
    if (options.port !== undefined) this.config.daemon.port = options.port;

    this.store = new EventStore(join(this.home, "vectr.db"));
    const claude = this.config.adapters["claude-code"];
    this.adapter = new ClaudeCodeAdapter({
      command: claude.command,
      permissionMode: claude.permission_mode,
      ...options.claudeCode,
    });
    const adapters = new Map<string, AgentAdapter>([[this.adapter.id, this.adapter]]);
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
      cancel: (taskId) => this.adapter.cancel(taskId),
    });
    this.orchestrator = new Orchestrator(this.store, this.config, () => this.scheduler.pump());
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
    await this.scheduler.stop(() => this.adapter.stopAll());
    this.store.close();
    rmSync(join(this.home, "vectrd.json"), { force: true });
  }
}

export function ensureToken(home: string): string {
  const file = join(home, "token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const token = randomBytes(32).toString("base64url");
  writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}
