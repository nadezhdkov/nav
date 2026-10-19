import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AntigravityAdapter, type AntigravityOptions } from "@navarch/adapter-antigravity";
import { ClaudeCodeAdapter, type ClaudeCodeOptions } from "@navarch/adapter-claude-code";
import { CodexAdapter, type CodexOptions } from "@navarch/adapter-codex";
import { CopilotAdapter, type CopilotOptions } from "@navarch/adapter-copilot";
import { GeminiCliAdapter, type GeminiCliOptions } from "@navarch/adapter-gemini-cli";
import { GrokAdapter, type GrokOptions } from "@navarch/adapter-grok";
import { KiloAdapter, type KiloOptions } from "@navarch/adapter-kilo";
import { OpencodeAdapter, type OpencodeOptions } from "@navarch/adapter-opencode";
import { NativeAdapter, type NativeOptions, type Provider } from "@navarch/adapter-native";
import { AgentRuntime } from "@navarch/agent-runtime";
import { Budgets, spends } from "./budgets/budgets.ts";
import { modelMetrics } from "./budgets/metrics.ts";
import { ConciergeService } from "./concierge/service.ts";
import { AwayService } from "./away/service.ts";
import { PrinciplesService } from "./principles/service.ts";
import { InboxService } from "./inbox/service.ts";
import { CiWatcher } from "./github/ci.ts";
import { AutoMerger } from "./github/automerge.ts";
import { SummaryService } from "./summary/service.ts";
import { PrWatcher } from "./github/outcomes.ts";
import { SpecSyncTrigger } from "./github/specsync.ts";
import { costPanel, qualityPanel, windowStart } from "./budgets/panels.ts";
import { knowledgePanel } from "./budgets/knowledge.ts";
import { PAUSE_INTERRUPT, registerSecret, type Actor, type AdapterId, type AgentAdapter, type RunMessage, type RemoteStatus, type RunView, type SendRunMessage, type SetBudgetRequest, type UsageView, type MetricsView } from "@navarch/contracts";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./api/server.ts";
import { GitHubIntegration } from "./github/integration.ts";
import { buildActions } from "./orchestrator/actions.ts";
import { homeFiles, loadConfig, type Config } from "./config.ts";
import { EventStore } from "./events/store.ts";
import { DeviceService } from "./devices/devices.ts";
import { Notifier } from "./notifications/notifier.ts";
import { tailscaleStatus } from "./remote/tailscale.ts";
import { FlowLibrary } from "./flows/library.ts";
import { Orchestrator } from "./orchestrator/orchestrator.ts";
import { PolicyEngine } from "./policy/engine.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import { Vault } from "./vault/vault.ts";

export type DaemonOptions = {
  home: string;
  config?: Config;
  /** Per-adapter overrides (tests point them at fake CLIs or a fake model server). */
  adapters?: {
    "claude-code"?: ClaudeCodeOptions;
    "gemini-cli"?: GeminiCliOptions;
    antigravity?: AntigravityOptions;
    codex?: CodexOptions;
    copilot?: CopilotOptions;
    opencode?: OpencodeOptions;
    kilo?: KiloOptions;
    grok?: GrokOptions;
    native?: Partial<NativeOptions>;
  };
  port?: number;
  /** Defaults to the OS keychain plus `NAVARCH_SECRET_*` (ADR 0007). */
  vault?: Vault;
};

type LogListener = (runId: string, taskId: string, line: string) => void;

/** `navarchd`: wires the event store, policy, orchestrator, scheduler, runtime and API. */
export class Daemon {
  readonly home: string;
  readonly config: Config;
  readonly store: EventStore;
  readonly orchestrator: Orchestrator;
  readonly scheduler: Scheduler;
  readonly adapters: Map<string, AgentAdapter>;
  readonly vault: Vault;
  readonly concierge: ConciergeService;
  readonly policy: PolicyEngine;
  readonly devices: DeviceService;
  readonly notifier: Notifier;
  readonly inbox: InboxService;
  readonly away: AwayService;
  readonly principles: PrinciplesService;
  readonly prs: PrWatcher;
  readonly ci: CiWatcher;
  readonly summary: SummaryService;
  readonly autoMerge: AutoMerger;
  readonly budgets: Budgets;
  readonly flows: FlowLibrary;
  private remoteCache: { at: number; status: RemoteStatus } | undefined;
  private readonly logListeners = new Set<LogListener>();
  private server?: FastifyInstance;
  private port?: number;

  constructor(options: DaemonOptions) {
    this.home = options.home;
    for (const dir of ["logs", "artifacts", "worktrees"]) mkdirSync(join(this.home, dir), { recursive: true });
    this.config = options.config ?? loadConfig(this.home);
    if (options.port !== undefined) this.config.daemon.port = options.port;

    this.store = new EventStore(homeFiles(this.home).db);
    this.vault = options.vault ?? new Vault();
    this.adapters = buildAdapters(this.config, options.adapters ?? {}, this.home, this.vault);
    const adapters = this.adapters;
    const runtime = new AgentRuntime({
      home: this.home,
      adapters,
      router: this.config.routing,
      publish: (event) => this.store.append([event]),
      onLog: (runId, taskId, line) => {
        for (const listener of this.logListeners) listener(runId, taskId, line);
      },
    });
    const policy = new PolicyEngine();
    this.policy = policy;
    const github = new GitHubIntegration(this.config, this.vault, policy);
    this.budgets = new Budgets({ store: this.store, config: this.config });
    // Billed use may cross a budget threshold: record it once per scope and period (ADR 0023).
    this.store.subscribe((event) => {
      if (!spends(event)) return;
      const run = event.run_id ? this.store.getRun(event.run_id) : undefined;
      const crossed = this.budgets.thresholdEvents(run);
      if (crossed.length) this.store.append(crossed);
    });
    this.principles = new PrinciplesService({ store: this.store, policy, autonomyLevel: this.config.autonomy_level });
    this.scheduler = new Scheduler({
      store: this.store,
      runtime,
      policy,
      config: this.config,
      budgets: this.budgets,
      cancel: async (taskId) => {
        await Promise.all([...adapters.values()].map((a) => a.cancel(taskId)));
      },
      actions: buildActions({ home: this.home, config: this.config, store: this.store, github }),
      onSucceeded: (runId) => this.orchestrator.advance(runId),
      billingOf: (adapter) => adapters.get(adapter)?.capabilities().billing ?? "metered",
      principles: (run) => this.principles.forRun(run),
      proposals: (run, task, summary) => this.principles.proposalsFrom(run, task, summary),
    });
    this.devices = new DeviceService(this.store, join(this.home, "device-key"));
    this.notifier = new Notifier({ store: this.store, devices: this.devices, policy, config: this.config, vapidFile: join(this.home, "push", "vapid.json") });
    this.flows = new FlowLibrary({ store: this.store, policy, adapters: [...adapters.keys()], autonomyLevel: this.config.autonomy_level });
    this.orchestrator = new Orchestrator(this.store, this.config, [...adapters.keys()], () => this.scheduler.pump(), github, this.flows, policy);
    this.orchestrator.stopRunning = (taskId, reason) => this.scheduler.requestStop(taskId, reason);
    this.concierge = new ConciergeService({
      config: this.config,
      store: this.store,
      orchestrator: this.orchestrator,
      runtime,
      adapters,
      requestCancel: (taskId) => this.scheduler.requestCancel(taskId),
      sendMessage: (runId, req, actor) => this.sendRunMessage(runId, req, actor),
      listInbox: () => this.inbox.list({ status: ["new", "triaged"] }),
      usage: () => this.usage({ days: 30 }),
      metrics: () => this.metrics({ days: 30 }),
    });
    this.inbox = new InboxService({ home: this.home, config: this.config, store: this.store, policy, github, orchestrator: this.orchestrator, runtime, adapters });
    this.away = new AwayService({ config: this.config, store: this.store, policy, orchestrator: this.orchestrator, runtime, adapters });
    const specSync = new SpecSyncTrigger({ config: this.config, store: this.store, orchestrator: this.orchestrator, policy });
    this.prs = new PrWatcher({ config: this.config, store: this.store, github, onMerged: (pr) => specSync.merged(pr) });
    this.ci = new CiWatcher({ config: this.config, store: this.store, github, orchestrator: this.orchestrator, policy });
    this.autoMerge = new AutoMerger({ config: this.config, store: this.store, policy, github });
    this.summary = new SummaryService({
      config: this.config,
      store: this.store,
      items: () => this.inbox.list().items,
      refresh: async () => {
        await Promise.allSettled([this.inbox.sync(undefined, { kind: "system", component: "summary" }), this.prs.check(), this.ci.check()]);
      },
    });
  }

  get url(): string {
    return `http://${this.config.daemon.host}:${this.port ?? this.config.daemon.port}`;
  }

  onLog(listener: LogListener): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  /** Whether an adapter can resume a session, so a `now` instruction can reach it (ADR 0019). */
  resumable(adapter: string): boolean {
    return this.adapters.get(adapter)?.capabilities().resumable ?? false;
  }

  /** An instruction from the user to a run (ADR 0019, `POST /api/v1/runs/:id/messages`). */
  pauseRun(runId: string, actor: Actor): RunView {
    return this.orchestrator.pauseRun(runId, actor, (taskId) => this.scheduler.requestInterrupt(taskId, PAUSE_INTERRUPT));
  }

  /**
   * The user sets or removes a budget limit (ADR 0023). Tasks waiting on `budget.exceed` whose
   * scopes are no longer used up are released, as if the user approved them.
   */
  setBudget(req: SetBudgetRequest, actor: Actor): void {
    this.store.append([this.budgets.setEvent(req, actor)]);
    for (const approval of this.store.listApprovals("pending")) {
      if (approval.action !== "budget.exceed") continue;
      const run = this.store.getRun(approval.run_id);
      if (!run || this.budgets.scopesOf(run).some((s) => s.state === "exceeded")) continue;
      this.orchestrator.decideApproval(approval.id, "approve", "budget raised", actor);
    }
  }

  /** The Usage screen (ADR 0023): budgets, spend today and this month, observed metrics per model, quotas. */
  usage(opts: { days: number; profile?: string }): UsageView {
    const now = Date.now();
    const attempts = this.store.attemptsSince(new Date(now - opts.days * 86_400_000).toISOString());
    return {
      generated_at: new Date(now).toISOString(),
      window_days: opts.days,
      today: this.store.usageTotals(this.budgets.day().from),
      month: this.store.usageTotals(this.budgets.month().from),
      budgets: this.budgets.views(),
      models: modelMetrics(attempts, {
        now,
        ...(opts.profile ? { profile: opts.profile } : {}),
        billingOf: (adapter) => this.adapters.get(adapter)?.capabilities().billing ?? "metered",
      }),
      quotas: this.store.quotas(now),
    };
  }

  /** The cost and quality panels (ADR 0037) over the last `days` local days. */
  metrics(opts: { days: number }): MetricsView {
    const now = Date.now();
    const from = windowStart(now, opts.days).toISOString();
    const attempts = this.store.attemptsSince(from);
    const prs = this.store.pullRequestsSince(from);
    const models = modelMetrics(attempts, { now, billingOf: (adapter) => this.adapters.get(adapter)?.capabilities().billing ?? "metered" });
    return {
      generated_at: new Date(now).toISOString(),
      window_days: opts.days,
      cost: costPanel(this.store.ledgerSince(from), { now, days: opts.days, projects: this.store.listProjects() }),
      quality: qualityPanel(attempts, prs, models),
      knowledge: knowledgePanel(attempts, prs),
    };
  }

  /** The kill switch: pauses every active run. */
  stopAll(actor: Actor): string[] {
    return this.orchestrator.stopAll(actor, (taskId) => this.scheduler.requestInterrupt(taskId, PAUSE_INTERRUPT));
  }

  sendRunMessage(runId: string, req: SendRunMessage, actor: Actor): RunMessage {
    return this.orchestrator.sendMessage(runId, req, actor, {
      decide: (who, resource) => this.policy.decide(who, "run.message", resource, { autonomyLevel: this.config.autonomy_level }),
      resumable: (adapter) => this.resumable(adapter),
      interrupt: (taskId) => this.scheduler.requestInterrupt(taskId),
    });
  }

  async start(): Promise<void> {
    const token = ensureToken(this.home);
    this.server = await buildServer(this, token);
    await this.server.listen({ host: this.config.daemon.host, port: this.config.daemon.port });
    const address = this.server.server.address();
    this.port = typeof address === "object" && address ? address.port : this.config.daemon.port;
    writeFileSync(homeFiles(this.home).daemonInfo, JSON.stringify({ pid: process.pid, url: this.url }));
    this.orchestrator.recover();
    this.notifier.start();
    this.inbox.start();
    this.away.start();
    this.prs.start();
    this.ci.start();
    this.summary.start();
    this.autoMerge.start();
    this.scheduler.pump();
    // Learn the tailnet origin in the background, for the stream's origin check (ADR 0020).
    void this.remoteStatus().catch(() => {});
  }

  /** Remote access as configured and as Tailscale reports it; cached for 30 seconds. */
  async remoteStatus(): Promise<RemoteStatus> {
    const remote = this.config.daemon.remote;
    const port = this.port ?? this.config.daemon.port;
    if (remote.mode === "off") {
      return { mode: "off", installed: false, running: false, url: null, serving: false, setup_command: `tailscale serve --bg ${port}` };
    }
    if (this.remoteCache && Date.now() - this.remoteCache.at < 30_000) return this.remoteCache.status;
    const detected = await tailscaleStatus(port, remote.tailscale_command);
    const status: RemoteStatus = { ...detected, url: remote.url?.replace(/\/+$/, "") ?? detected.url };
    this.remoteCache = { at: Date.now(), status };
    return status;
  }

  /** The phone's origin, if known, for the WebSocket origin check. */
  remoteOrigin(): string | undefined {
    if (this.config.daemon.remote.mode === "off") return undefined;
    const url = this.config.daemon.remote.url ?? this.remoteCache?.status.url ?? undefined;
    return url ? new URL(url).origin : undefined;
  }

  /**
   * Stops the API and kills agent subprocesses without recording an outcome: running tasks stay
   * `running` in the log and are requeued as `interrupted` on the next start.
   */
  async stop(): Promise<void> {
    await this.server?.close();
    await this.notifier.stop();
    await this.inbox.stop();
    await this.away.stop();
    await this.prs.stop();
    await this.ci.stop();
    await this.summary.stop();
    await this.autoMerge.stop();
    await this.scheduler.stop(async () => {
      await Promise.all([...this.adapters.values()].map((a) => a.stopAll()));
    });
    this.store.close();
    rmSync(homeFiles(this.home).daemonInfo, { force: true });
  }
}

/**
 * Enabled adapters, keyed by id. A native provider's API key comes from its `api_key_env`
 * variable, else from the Vault (`api_key: secret://…`), read when a task starts and registered
 * for redaction.
 */
export function buildAdapters(
  config: Config,
  overrides: NonNullable<DaemonOptions["adapters"]>,
  home: string,
  vault?: Vault,
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
    ["copilot", a.copilot.enabled, () => new CopilotAdapter({ command: a.copilot.command, ...overrides.copilot })],
    ["opencode", a.opencode.enabled, () => new OpencodeAdapter({ command: a.opencode.command, ...overrides.opencode })],
    ["kilo", a.kilo.enabled, () => new KiloAdapter({ ...(a.kilo.command ? { command: a.kilo.command } : {}), ...overrides.kilo })],
    ["grok", a.grok.enabled, () => new GrokAdapter({ command: a.grok.command, homeRoot: join(home, "agents", "grok"), ...overrides.grok })],
    [
      "native",
      a.native.enabled,
      () => {
        const providers: Record<string, Provider> = {};
        for (const [name, p] of Object.entries(a.native.providers)) {
          const ref = p.api_key;
          const getApiKey = async (): Promise<string | undefined> => {
            const fromEnv = p.api_key_env ? process.env[p.api_key_env] : undefined;
            const key = fromEnv || (ref && vault ? await vault.get(ref).catch(() => undefined) : undefined);
            if (key) registerSecret(key);
            return key;
          };
          providers[name] = {
            baseUrl: p.base_url,
            ...(p.api_key_env || ref ? { getApiKey, requiresKey: true } : {}),
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
  const read = () => readFileSync(file, "utf8").trim();
  try {
    return read();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const token = randomBytes(32).toString("base64url");
  // "wx" creates the file or fails: of two daemons starting together only one writes, the other reads its token.
  try {
    writeFileSync(file, token + "\n", { mode: 0o600, flag: "wx" });
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return read();
  }
}
