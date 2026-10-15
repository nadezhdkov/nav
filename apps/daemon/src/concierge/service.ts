import { NativeAdapter, ModelError } from "@navarch/adapter-native";
import type { AgentRuntime } from "@navarch/agent-runtime";
import { Conversation, NativeChatEngine, type ConciergeEngine, type ConciergeEvent, type EngineMessage, type EngineReply, type EngineToolSpec } from "@navarch/concierge";
import { newId, type Actor, type AgentAdapter, type ProposalView, type RunMessage, type SendRunMessage } from "@navarch/contracts";
import type { Config } from "../config.ts";
import type { EventStore } from "../events/store.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
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
};

type Via = Extract<Actor, { kind: "user" }>["via"];
type Entry = { conversation: Conversation; via: Via };

const MAX_CONVERSATIONS = 50;

export class ConciergeService {
  private readonly deps: ConciergeDeps;
  private readonly conversations = new Map<string, Entry>();

  constructor(deps: ConciergeDeps) {
    this.deps = deps;
  }

  create(cwd: string | undefined, via: Via): { id: string } {
    const native = this.deps.adapters.get("native");
    if (!this.deps.config.concierge.enabled) throw new ConciergeError("unavailable", "the concierge is disabled (concierge.enabled: false)");
    if (!(native instanceof NativeAdapter)) throw new ConciergeError("unavailable", "the concierge needs the native adapter (adapters.native.enabled)");
    const id = newId("conv");
    const entry: Entry = { via, conversation: undefined as unknown as Conversation };
    entry.conversation = new Conversation({
      id,
      engine: new RoutedEngine(native, () => this.candidates()),
      tools: conciergeTools({
        store: this.deps.store,
        orchestrator: this.deps.orchestrator,
        requestCancel: this.deps.requestCancel,
        sendMessage: this.deps.sendMessage,
        actor: () => ({ kind: "user", via: entry.via }),
        ...(cwd ? { cwd } : {}),
      }),
      context: cwd ? `The operator's current directory is ${cwd}; runs default to that repository.` : undefined,
      onEvent: (event) => this.record(event, entry),
      newId: () => newId("prop"),
      maxSteps: this.deps.config.concierge.max_steps,
    });
    this.conversations.set(id, entry);
    // Oldest first: drop conversations nobody is likely to come back to.
    while (this.conversations.size > MAX_CONVERSATIONS) this.conversations.delete(this.conversations.keys().next().value!);
    return { id };
  }

  async send(id: string, text: string, via: Via): Promise<{ reply: string; proposals: ProposalView[]; model: string }> {
    const entry = this.get(id);
    entry.via = via;
    try {
      return await entry.conversation.send(text);
    } catch (err) {
      if (err instanceof NoModelError) throw new ConciergeError("unavailable", err.message);
      if (err instanceof ModelError) throw new ConciergeError("unavailable", `the concierge's model failed: ${err.message}`);
      throw err;
    }
  }

  async decide(id: string, proposalId: string, decision: "approve" | "reject", via: Via): Promise<{ reply: string; proposal: ProposalView }> {
    const entry = this.get(id);
    entry.via = via;
    try {
      const { reply, proposal } = await entry.conversation.decide(proposalId, decision);
      return { reply, proposal };
    } catch (err) {
      throw new ConciergeError("bad_request", (err as Error).message);
    }
  }

  /** Model ids to try, in order: the pinned one, or the router's choice and the rest of its tier. */
  private candidates(): string[] {
    const pinned = this.deps.config.concierge.model;
    if (pinned) return [pinned];
    const nonNative = Object.entries(this.deps.config.routing.models)
      .filter(([, e]) => e.adapter !== "native")
      .map(([id]) => id);
    const exclude = [...nonNative];
    const models: string[] = [];
    let reason = "";
    // The router returns its first usable entry; ask again without it to get the fallbacks.
    for (let i = 0; i < 3; i++) {
      const decision = this.deps.runtime.route({ profile: "concierge", iteration: 1, implementerProviders: [], exhausted: this.deps.store.exhaustedQuotas(), exclude });
      if (!decision?.chosen?.model) {
        reason ||= decision ? `${decision.reason}${decision.skipped.length ? ` (${decision.skipped.map((s) => `${s.id}: ${s.reason}`).join("; ")})` : ""}` : "routing is off";
        break;
      }
      models.push(decision.chosen.model);
      exclude.push(decision.chosen.id);
    }
    if (!models.length) {
      throw new NoModelError(
        `no model for the concierge: ${reason}. Set concierge.model to a native model (e.g. openrouter/<id>:free) or add native entries to the concierge's tier (routing.profiles.concierge, default fast).`,
      );
    }
    return models;
  }

  private get(id: string): Entry {
    const entry = this.conversations.get(id);
    if (!entry) throw new ConciergeError("not_found", `conversation ${id} not found (the daemon may have restarted)`);
    return entry;
  }

  private record(event: ConciergeEvent, entry: Entry): void {
    const user: Actor = { kind: "user", via: entry.via };
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
