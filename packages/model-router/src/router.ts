/**
 * Model Router v1 (spec §6.4, ADR 0013): picks the catalog entry an agent task runs on. A
 * catalog entry is an agent adapter plus an optional model, because Navarch's CLI adapters are
 * whole agents. The policy is a pure function of the catalog, the tier lists and what the run
 * knows so far (triage complexity, loop iteration, the implementer's provider, exhausted
 * quotas); it never calls a model. Only the Agent Runtime calls it (architecture rule 4).
 */

export const TIERS = ["fast", "standard", "expert"] as const;
export type Tier = (typeof TIERS)[number];

export type CatalogEntry = {
  adapter: string;
  /** The adapter's model; absent means the adapter's own default. */
  model?: string;
  /** Who serves the model, for "reviewer on a different provider" (spec §6.3.3). */
  provider: string;
  status: "active" | "disabled";
};

export type RouterConfig = {
  /** Catalog id → entry. */
  models: Record<string, CatalogEntry>;
  /** Candidate catalog ids per tier, in order of preference. */
  tiers: Record<Tier, string[]>;
  /** The tier each Agent Profile needs (spec §6.3.3). */
  profiles: Record<string, Tier>;
  /** Planner and implementer of a run whose triage complexity is at most this use the `fast` tier. */
  simple_max_complexity: number;
  /** Profiles that should run on a provider other than the run's implementer. */
  different_provider: string[];
};

export type RouteRequest = {
  profile: string;
  /** From the run's triage (1–5), when there was one. */
  complexity?: number;
  /** Loop iteration of the task; a later implementer iteration means verification failed. */
  iteration: number;
  /** Providers the run's implementer used, for profiles in `different_provider`. */
  implementerProviders: string[];
  /** Adapters the daemon has enabled. */
  adapters: ReadonlySet<string>;
  /** Exhausted quotas: the adapter, optionally only its models with this id prefix, and when they reset (ISO 8601). */
  exhausted: ReadonlyArray<{ adapter: string; modelPrefix?: string; resetsAt: string }>;
  /** Why an entry's adapter cannot run its model now (e.g. no API key), if it cannot. */
  unavailable?: (entry: CatalogEntry) => string | undefined;
  /** Catalog ids not to use, e.g. the one that just hit its rate limit. */
  exclude?: string[];
};

export type RouteDecision = {
  /** Undefined when no candidate is usable. */
  chosen?: { id: string; adapter: string; model?: string; provider: string };
  tier: Tier;
  reason: string;
  candidates: string[];
  skipped: { id: string; reason: string }[];
};

const ESCALATED_PROFILES = new Set(["implementer"]);
const SIMPLE_PROFILES = new Set(["planner", "implementer"]);

export function tierFor(config: RouterConfig, req: Pick<RouteRequest, "profile" | "complexity" | "iteration">): { tier: Tier; why: string } {
  let tier: Tier = config.profiles[req.profile] ?? "standard";
  let why = `${req.profile} needs ${tier}`;
  if (SIMPLE_PROFILES.has(req.profile) && req.complexity !== undefined && req.complexity <= config.simple_max_complexity) {
    tier = "fast";
    why = `triage complexity ${req.complexity} ≤ ${config.simple_max_complexity}`;
  }
  if (ESCALATED_PROFILES.has(req.profile) && req.iteration > 1) {
    const up = TIERS[Math.min(TIERS.indexOf(tier) + 1, TIERS.length - 1)]!;
    if (up !== tier) why += `, escalated to ${up} after failed verification`;
    tier = up;
  }
  return { tier, why };
}

export function route(config: RouterConfig, req: RouteRequest): RouteDecision {
  const { tier, why } = tierFor(config, req);
  const candidates = config.tiers[tier] ?? [];
  const skipped: RouteDecision["skipped"] = [];
  const usable: string[] = [];
  for (const id of candidates) {
    const entry = config.models[id];
    const quota = entry && req.exhausted.find((q) => q.adapter === entry.adapter && (!q.modelPrefix || (entry.model ?? "").startsWith(q.modelPrefix)));
    const skip = !entry
      ? "not in the catalog"
      : entry.status !== "active"
        ? `status ${entry.status}`
        : !req.adapters.has(entry.adapter)
          ? `adapter ${entry.adapter} not enabled`
          : req.exclude?.includes(id)
            ? "rate limited"
            : quota
              ? `quota exhausted until ${quota.resetsAt}`
              : req.unavailable?.(entry);
    if (skip) skipped.push({ id, reason: skip });
    else usable.push(id);
  }

  let pick = usable[0];
  let providerNote = "";
  if (config.different_provider.includes(req.profile) && req.implementerProviders.length) {
    const other = usable.find((id) => !req.implementerProviders.includes(config.models[id]!.provider));
    if (other) {
      for (const id of usable.slice(0, usable.indexOf(other))) skipped.push({ id, reason: "same provider as the implementer" });
      pick = other;
      providerNote = `, provider other than the implementer's (${req.implementerProviders.join(", ")})`;
    } else if (pick) {
      providerNote = `; no usable candidate from another provider than the implementer's`;
    }
  }

  if (!pick) return { tier, reason: `${why}; no usable candidate in tier ${tier}`, candidates, skipped };
  const entry = config.models[pick]!;
  return {
    chosen: { id: pick, adapter: entry.adapter, ...(entry.model ? { model: entry.model } : {}), provider: entry.provider },
    tier,
    reason: `${why}; first usable in tier ${tier}${providerNote}`,
    candidates,
    skipped,
  };
}

