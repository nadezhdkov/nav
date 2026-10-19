import type { Actor } from "@navarch/contracts";
import type { Config } from "../config.ts";
import type { EventStore, PullRequestRecord } from "../events/store.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import type { PolicyEngine } from "../policy/engine.ts";

const auto: Actor = { kind: "system", component: "spec-sync" };
/** Flows whose own pull requests only add specs; syncing on their merge would never end. */
const SPEC_FLOWS = new Set(["reverse-spec", "spec-sync"]);

/**
 * Starts `spec-sync` on its own after a pull request Navarch opened is merged (ADR 0052). Off by
 * default (`spec_sync.auto`). It acts only for a registered project that already keeps specs, once
 * per pull request, within `spec_sync.daily_runs`, and never for a pull request that only added
 * specs. The run it starts is an ordinary `spec-sync` run: its own PR waits for approval below
 * autonomy level 3.
 */
export class SpecSyncTrigger {
  private readonly deps: { config: Config; store: EventStore; orchestrator: Orchestrator; policy: PolicyEngine; now?: () => number };
  private readonly starting = new Set<string>();

  constructor(deps: SpecSyncTrigger["deps"]) {
    this.deps = deps;
  }

  /** Considers one merged pull request; a refusal or a failure to start leaves nothing behind. */
  async merged(pr: PullRequestRecord): Promise<void> {
    const { config, store, orchestrator, policy } = this.deps;
    if (!config.spec_sync.auto) return;
    const key = `${pr.repo.toLowerCase()}#${pr.number}`;
    if (this.starting.has(key) || store.hasAutoSpecSync(pr.repo, pr.number)) return;
    const flow = pr.run_id ? store.getRun(pr.run_id)?.flow : undefined;
    if (flow && SPEC_FLOWS.has(flow)) return;
    const project = store.listProjects().find((p) => !p.removed_at && p.repo.toLowerCase() === pr.repo.toLowerCase());
    if (!project || !store.projectHasSpecs(project.path)) return;

    const now = new Date((this.deps.now ?? Date.now)());
    const since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const decision = policy.decide(auto, "spec.auto_sync", key, {
      autonomyLevel: config.autonomy_level,
      usage: { items: store.autoSpecSyncsSince(since), usd: 0 },
      cap: { items: config.spec_sync.daily_runs, usd: 0 },
    });
    if (decision.effect !== "allow") return;

    this.starting.add(key);
    try {
      const run = await orchestrator.startRun({ repo_path: project.path, pull_request: `${pr.repo}#${pr.number}`, flow: "spec-sync" }, auto);
      store.append([{ type: "spec.sync.auto_started", run_id: run.id, task_id: null, actor: auto, payload: { repo: pr.repo, number: pr.number, project_id: project.id, run_id: run.id } }]);
    } catch {
      // The pull request may not be readable yet; the user can still start spec-sync by hand.
    } finally {
      this.starting.delete(key);
    }
  }
}
