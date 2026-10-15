import type { AgentRuntime } from "@navarch/agent-runtime";
import type { Config } from "../config.ts";
import type { EventStore } from "../events/store.ts";

/**
 * API models for work that runs in the daemon without a worktree (the concierge, ADR 0016; the
 * Inbox triage, ADR 0021): the pinned model, or the router's `native` entries for the profile's
 * tier, best first, with exhausted quotas skipped. Asking the Agent Runtime keeps rule 4.
 */
export function nativeModels(deps: { runtime: AgentRuntime; config: Config; store: EventStore }, profile: string, pinned?: string): { models: string[] } | { reason: string } {
  if (pinned) return { models: [pinned] };
  const exclude = Object.entries(deps.config.routing.models)
    .filter(([, e]) => e.adapter !== "native")
    .map(([id]) => id);
  const models: string[] = [];
  let reason = "";
  // The router returns its first usable entry; ask again without it to get the fallbacks.
  for (let i = 0; i < 3; i++) {
    const decision = deps.runtime.route({ profile, iteration: 1, implementerProviders: [], exhausted: deps.store.exhaustedQuotas(), exclude });
    if (!decision?.chosen?.model) {
      reason ||= decision ? `${decision.reason}${decision.skipped.length ? ` (${decision.skipped.map((s) => `${s.id}: ${s.reason}`).join("; ")})` : ""}` : "routing is off";
      break;
    }
    models.push(decision.chosen.model);
    exclude.push(decision.chosen.id);
  }
  return models.length ? { models } : { reason };
}
