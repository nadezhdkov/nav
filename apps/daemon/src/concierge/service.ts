import { NativeAdapter, ModelError } from "@navarch/adapter-native";
import type { AgentRuntime } from "@navarch/agent-runtime";
import { Conversation, NativeChatEngine, type ConciergeEngine, type ConciergeEvent, type EngineMessage, type EngineReply, type EngineToolSpec } from "@navarch/concierge";
import { newId, type Actor, type AgentAdapter, type InboxView, type ProposalView, type RunMessage, type SendRunMessage, type UsageView, type MetricsView } from "@navarch/contracts";
import type { Config } from "../config.ts";
import type { EventStore } from "../events/store.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import { nativeModels } from "../routing/native-models.ts";
import { conciergeTools } from "./tools.ts";

/**
 * Concierge conversations (ADR 0016). Each message picks a model through the Agent Runtime
 * (profile `concierge`, `native` entries only) unless `concierge.model` pins one, and a rate
 * limit moves the turn to the next candidate. Conversations live in memory.
 */

export class ConciergeError extends Error {
  readonly code: "not_found" | "unavailable" | "bad_request";

  constructor(code: ConciergeError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export type ConciergeDeps = {
  config: Config;
  store: EventStore;
  orchestrator: Orchestrator;
  runtime: AgentRuntime;
  adapters: Map<string, AgentAdapter>;
  requestCancel: (taskId: string) => void;
  sendMessage: (runId: string, req: SendRunMessage, actor: Actor) => RunMessage;
  listInbox?: () => InboxView;
  /** Repositories a paired device may start runs in. */
  knownRepos?: () => string[];
  usage?: () => UsageView;
  metrics?: () => MetricsView;
};

type Via = Extract<Actor, { kind: "user" }>["via"];
/** Who is talking: a client by its channel, or a paired phone by its device (ADR 0063). */
export type Origin = { via: Via; deviceId?: string };
type Entry = { conversation: Conversation; origin: Origin };

const userActor = (o: Origin): Actor => ({ kind: "user", via: o.via, ...(o.deviceId ? { device_id: o.deviceId } : {}) });

const MAX_CONVERSATIONS = 50;

export class ConciergeService {
  private readonly deps: ConciergeDeps;
  private readonly conversations = new Map<string, Entry>();

  constructor(deps: ConciergeDeps) {
    this.deps = deps;
  }

  create(cwd: string | undefined, origin: Origin): { id: string } {
    const native = this.deps.adapters.get("native");
    if (!this.deps.config.concierge.enabled) throw new ConciergeError("unavailable", "the concierge is disabled (concierge.enabled: false)");
    if (!(native instanceof NativeAdapter)) throw new ConciergeError("unavailable", "the concierge needs the native adapter (adapters.native.enabled)");
    const id = newId("conv");
    const entry: Entry = { origin, conversation: undefined as unknown as Conversation };
    entry.conversation = new Conversation({
      id,
      engine: new RoutedEngine(native, () => this.candidates()),
      tools: conciergeTools({
        store: this.deps.store,
        orchestrator: this.deps.orchestrator,
        requestCancel: this.deps.requestCancel,
        sendMessage: this.deps.sendMessage,
        ...(this.deps.listInbox ? { listInbox: this.deps.listInbox } : {}),
        ...(this.deps.usage ? { usage: this.deps.usage } : {}),
        ...(this.deps.metrics ? { metrics: this.deps.metrics } : {}),
        actor: () => userActor(entry.origin),
        // A phone sets no working directory and gets the device limits on start_run.
        ...(origin.deviceId ? { device: { knownRepos: this.deps.knownRepos ?? (() => []) } } : cwd ? { cwd } : {}),
      }),
      context: cwd && !origin.deviceId ? `The operator's current directory is ${cwd}; runs default to that repository.` : undefined,
      onEvent: (event) => this.record(event, entry),
      newId: () => newId("prop"),
      maxSteps: this.deps.config.concierge.max_steps,
    });
    this.conversations.set(id, entry);
    // Oldest first: drop conversations nobody is likely to come back to.
    while (this.conversations.size > MAX_CONVERSATIONS) this.conversations.delete(this.conversations.keys().next().value!);
    return { id };
  }

  async send(id: string, text: string, origin: Origin): Promise<{ reply: string; proposals: ProposalView[]; model: string }> {
    const entry = this.get(id, origin);
    entry.origin = origin;
    try {
      return await entry.conversation.send(text);
    } catch (err) {
      if (err instanceof NoModelError) throw new ConciergeError("unavailable", err.message);
      if (err instanceof ModelError) throw new ConciergeError("unavailable", `the concierge's model failed: ${err.message}`);
      throw err;
    }
  }

  async decide(id: string, proposalId: string, decision: "approve" | "reject", origin: Origin): Promise<{ reply: string; proposal: ProposalView }> {
    const entry = this.get(id, origin);
    entry.origin = origin;
    try {
      const { reply, proposal } = await entry.conversation.decide(proposalId, decision);
      return { reply, proposal };
    } catch (err) {
      throw new ConciergeError("bad_request", (err as Error).message);
    }
  }

  /** Model ids to try, in order: the pinned one, or the router's choice and the rest of its tier. */
  private candidates(): string[] {
    const found = nativeModels(this.deps, "concierge", this.deps.config.concierge.model);
    if ("reason" in found) {
      throw new NoModelError(
        `no model for the concierge: ${found.reason}. Set concierge.model to a native model (e.g. openrouter/<id>:free) or add native entries to the concierge's tier (routing.profiles.concierge, default fast).`,
      );
    }
    return found.models;
  }

  /** A phone reaches only its own conversations; the desktop and the CLI reach any. */
  private get(id: string, origin: Origin): Entry {
    const entry = this.conversations.get(id);
    if (!entry || (origin.deviceId && entry.origin.deviceId !== origin.deviceId)) throw new ConciergeError("not_found", `conversation ${id} not found (the daemon may have restarted)`);
    return entry;
  }

  private record(event: ConciergeEvent, entry: Entry): void {
    const user = userActor(entry.origin);
    const agent: Actor = { kind: "agent", profile: "concierge", adapter: "native", model: entry.conversation.model };
    const actor = event.type === "concierge.action.proposed" || (event.type === "concierge.message" && event.payload.role === "assistant") ? agent : user;
    this.deps.store.append([{ type: event.type, run_id: event.run_id, task_id: null, actor, payload: event.payload } as Parameters<EventStore["append"]>[0][number]]);
  }
}

class NoModelError extends Error {}

/** Picks the model per call and moves to the next candidate when one is rate limited. */
class RoutedEngine implements ConciergeEngine {
  model = "(not chosen yet)";
  private readonly native: NativeAdapter;
  private readonly candidates: () => string[];

  constructor(native: NativeAdapter, candidates: () => string[]) {
    this.native = native;
    this.candidates = candidates;
  }

  async complete(messages: EngineMessage[], tools: EngineToolSpec[], signal?: AbortSignal): Promise<EngineReply> {
    const models = this.candidates();
    let last: unknown;
    for (const model of models) {
      this.model = model;
      try {
        return await new NativeChatEngine(this.native, model).complete(messages, tools, signal);
      } catch (err) {
        last = err;
        if (!(err instanceof ModelError) || (err.kind !== "rate_limited" && err.kind !== "transient")) throw err;
      }
    }
    throw last;
  }
}
