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
  /** A candidate with a quota window at least this used goes after the others (ADR 0023). */
  quota_reserve?: number;
  /** A candidate failing at this rate or more over enough recent tasks goes after the others. */
  degraded_error_rate?: number;
};

/** What Navarch has observed of a catalog entry (spec §6.4.1), as far as routing needs it. */
export type Observed = {
  /** Median billed cost of the entry's succeeded tasks for this profile; absent without enough history. */
  expectedCost?: number;
  /** Failures (not rate limits or cancellations) over finished tasks in the last 24 h. */
  recent?: { failed: number; total: number };
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
  /** A team lead's preference for this member (ADR 0022): a catalog id or an adapter, tried first when usable. */
  prefer?: string;
  /** The smallest amount left in the run's budgets; absent or Infinity when nothing is limited (ADR 0023). */
  budgetRemaining?: number;
  /** Whether an entry's use is billed; only `metered` entries are filtered by budget. */
  billing?: (entry: CatalogEntry) => "metered" | "plan";
  /** Quota windows not exhausted yet, with how much of them is used. */
  quotaUse?: ReadonlyArray<{ adapter: string; modelPrefix?: string; window: string; utilization: number; resetsAt?: string }>;
  /** Observed metrics of a catalog entry for this request's profile. */
  observed?: (id: string) => Observed | undefined;
};

/** Below this many recent tasks an error rate says nothing. */
export const MIN_RECENT_TASKS = 4;

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

const appliesTo = (q: { adapter: string; modelPrefix?: string }, entry: CatalogEntry) =>
  q.adapter === entry.adapter && (!q.modelPrefix || (entry.model ?? "").startsWith(q.modelPrefix));

function unusable(config: RouterConfig, req: RouteRequest, id: string): string | undefined {
  const entry = config.models[id];
  const quota = entry && req.exhausted.find((q) => appliesTo(q, entry));
  return !entry
    ? "not in the catalog"
    : entry.status !== "active"
      ? `status ${entry.status}`
      : !req.adapters.has(entry.adapter)
        ? `adapter ${entry.adapter} not enabled`
        : req.exclude?.includes(id)
          ? "rate limited"
          : quota
            ? `quota exhausted until ${quota.resetsAt}`
            : (req.unavailable?.(entry) ?? overBudget(req, id, entry));
}

/** Step 3 of spec §6.4.2: a billed entry expected to cost more than the run has left (ADR 0023). */
function overBudget(req: RouteRequest, id: string, entry: CatalogEntry): string | undefined {
  const left = req.budgetRemaining;
  if (left === undefined || !Number.isFinite(left) || req.billing?.(entry) !== "metered") return undefined;
  const expected = req.observed?.(id)?.expectedCost;
  return expected !== undefined && expected > left ? `expected $${expected.toFixed(2)}, $${left.toFixed(2)} left in the budget` : undefined;
}

/** Why a usable entry should wait behind the others: a nearly used quota or many recent failures. */
function demotion(config: RouterConfig, req: RouteRequest, id: string): string | undefined {
  const entry = config.models[id]!;
  const reserve = config.quota_reserve ?? 1;
  const busy = req.quotaUse?.filter((q) => appliesTo(q, entry) && q.utilization >= reserve).sort((a, b) => b.utilization - a.utilization)[0];
  if (busy) return `quota ${Math.round(busy.utilization * 100)} % used${busy.resetsAt ? ` until ${busy.resetsAt}` : ""}, kept for later`;
  const recent = req.observed?.(id)?.recent;
  const limit = config.degraded_error_rate ?? 1;
  if (recent && recent.total >= MIN_RECENT_TASKS && recent.failed / recent.total >= limit) return `${recent.failed} of ${recent.total} tasks failed in 24 h`;
  return undefined;
}

export function route(config: RouterConfig, req: RouteRequest): RouteDecision {
  const { tier, why } = tierFor(config, req);
  const candidates = config.tiers[tier] ?? [];
  const skipped: RouteDecision["skipped"] = [];
  if (req.prefer) {
    const preferred = config.models[req.prefer] ? [req.prefer] : Object.keys(config.models).filter((id) => config.models[id]!.adapter === req.prefer);
    for (const id of preferred) {
      const skip = unusable(config, req, id);
      if (skip) {
        skipped.push({ id, reason: `preferred by the lead; ${skip}` });
        continue;
      }
      const entry = config.models[id]!;
      return {
        chosen: { id, adapter: entry.adapter, ...(entry.model ? { model: entry.model } : {}), provider: entry.provider },
        tier,
        reason: `preferred by the lead (${req.prefer})`,
        candidates: [id, ...candidates.filter((c) => c !== id)],
        skipped,
      };
    }
  }
  const ready: string[] = [];
  const later: { id: string; why: string }[] = [];
  for (const id of candidates) {
    const entry = config.models[id];
    const skip = entry ? unusable(config, req, id) : "not in the catalog";
    if (skip) {
      skipped.push({ id, reason: skip });
      continue;
    }
    const why = demotion(config, req, id);
    if (why) later.push({ id, why });
    else ready.push(id);
  }
  // Demoted entries keep their order among themselves, after every other usable one.
  const usable = [...ready, ...later.map((l) => l.id)];
  const laterNote = later.length ? `; after the others: ${later.map((l) => `${l.id} (${l.why})`).join(", ")}` : "";

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
  const demoted = later.find((l) => l.id === pick);
  const entry = config.models[pick]!;
  return {
    chosen: { id: pick, adapter: entry.adapter, ...(entry.model ? { model: entry.model } : {}), provider: entry.provider },
    tier,
    reason: demoted
      ? `${why}; every candidate in tier ${tier} is held back, using ${pick} (${demoted.why})${providerNote}`
      : `${why}; first usable in tier ${tier}${providerNote}${laterNote}`,
    candidates,
    skipped,
  };
}

