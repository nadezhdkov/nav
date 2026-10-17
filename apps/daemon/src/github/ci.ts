import { createHash } from "node:crypto";
import type { Actor, CiFailureView, FixCiFailureRequest, RunView } from "@navarch/contracts";
import { GitHubError } from "@navarch/github";
import type { Config } from "../config.ts";
import type { EventStore, ProjectRecord } from "../events/store.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import type { PolicyEngine } from "../policy/engine.ts";
import type { GitHubIntegration } from "./integration.ts";

const watcher: Actor = { kind: "system", component: "github" };
const auto: Actor = { kind: "system", component: "ci" };
const TICK_MS = 60_000;
/** A listing this long may be cut off, so a pull request missing from it is not taken as closed. */
const LISTING_LIMIT = 100;
/** The branch `ci-fix` pushes to; a failure there must not start another fix. */
const OWN_FIX_BRANCH = /^navarch\/[^/]+\/ci-fix$/;

export class CiError extends Error {
  readonly code: "not_found" | "conflict";

  constructor(code: CiError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The CI watcher (ADR 0041): on the Inbox's schedule it reads each project's open pull requests and
 * their check runs, and records a failing head once. The user starts `ci-fix` from it, or the daemon
 * does with `ci_fix.auto`. Watching only reads; the run it starts is an ordinary `ci-fix` run.
 */
export class CiWatcher {
  private readonly deps: { config: Config; store: EventStore; github: GitHubIntegration; orchestrator: Orchestrator; policy: PolicyEngine; now?: () => number };
  private readonly starting = new Set<string>();
  private lastPoll = 0;
  private polling: Promise<number> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(deps: CiWatcher["deps"]) {
    this.deps = deps;
  }

  start(): void {
    this.stopped = false;
    if (this.deps.config.inbox.poll_minutes <= 0) return;
    this.timer = setInterval(() => {
      if ((this.deps.now ?? Date.now)() - this.lastPoll >= this.deps.config.inbox.poll_minutes * 60_000) void this.check();
    }, TICK_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.polling?.catch(() => {});
  }

  list(status?: CiFailureView["status"]): CiFailureView[] {
    return this.deps.store.ciFailures(status);
  }

  /** Reads every project once; returns how many new failures it recorded. One check at a time. */
  check(): Promise<number> {
    this.polling ??= this.checkAll().finally(() => (this.polling = undefined));
    return this.polling;
  }

  /** The user starts `ci-fix` on a failure. */
  async fix(id: string, req: FixCiFailureRequest, actor: Actor): Promise<{ failure: CiFailureView; run: RunView }> {
    const failure = this.failure(id);
    if (failure.status !== "open") throw new CiError("conflict", `this failure is ${failure.status}, not open`);
    const run = await this.startFix(failure, actor, req.budget, false);
    return { failure: this.failure(id), run };
  }

  dismiss(id: string, actor: Actor): CiFailureView {
    const failure = this.failure(id);
    if (failure.status === "open") this.deps.store.append([{ type: "ci.failure.dismissed", run_id: null, task_id: null, actor, payload: { failure_id: id } }]);
    return this.failure(id);
  }

  private failure(id: string): CiFailureView {
    const failure = this.deps.store.getCiFailure(id);
    if (!failure) throw new CiError("not_found", `no CI failure ${id}`);
    return failure;
  }

  private async startFix(failure: CiFailureView, actor: Actor, budget: number | undefined, byDaemon: boolean): Promise<RunView> {
    const project = this.deps.store.getProject(failure.project_id);
    if (!project || project.removed_at) throw new CiError("conflict", "the project of this failure is no longer registered");
    if (this.starting.has(failure.id)) throw new CiError("conflict", "a run for this failure is starting");
    this.starting.add(failure.id);
    try {
      const run = await this.deps.orchestrator.startRun(
        { repo_path: project.path, pull_request: `${failure.repo}#${failure.number}`, flow: "ci-fix", ...(budget ? { budget } : {}) },
        actor,
      );
      this.deps.store.append([{ type: "ci.failure.started", run_id: run.id, task_id: null, actor, payload: { failure_id: failure.id, run_id: run.id, auto: byDaemon } }]);
      return run;
    } finally {
      this.starting.delete(failure.id);
    }
  }

  private async checkAll(): Promise<number> {
    this.lastPoll = (this.deps.now ?? Date.now)();
    let detected = 0;
    for (const project of this.deps.store.listProjects()) {
      if (this.stopped) break;
      try {
        detected += await this.checkProject(project);
      } catch (err) {
        if (err instanceof GitHubError && (err.status === 403 || err.status === 429)) break; // Rate limited: the rest waits for the next poll.
        // Anything else (network, no token, repository gone) is retried on the next poll.
      }
    }
    return detected;
  }

  private async checkProject(project: ProjectRecord): Promise<number> {
    const { store, github } = this.deps;
    const prs = await github.listOpenPullRequests(project.repo);
    const known = store.ciFailures().filter((f) => f.project_id === project.id);
    let detected = 0;
    for (const pr of prs) {
      if (this.stopped) break;
      // A fork's code must not run on a trigger nobody asked for; Navarch's own fix branch must not start another fix.
      if (pr.head_repo.toLowerCase() !== project.repo.toLowerCase() || OWN_FIX_BRANCH.test(pr.head_ref)) continue;
      if (known.some((f) => f.number === pr.number && f.head_sha === pr.head_sha)) continue;
      const status = await github.checkStatus(project.repo, pr.head_sha);
      if (status.pending > 0 || status.failing.length === 0) continue;
      const failure_id = `cif_${createHash("sha1").update(`${project.repo.toLowerCase()}#${pr.number}@${pr.head_sha}`).digest("hex").slice(0, 10)}`;
      store.append([
        {
          type: "ci.failure.detected",
          run_id: null,
          task_id: null,
          actor: watcher,
          payload: { failure_id, project_id: project.id, repo: project.repo, number: pr.number, title: pr.title, author: pr.author, url: pr.url, head_ref: pr.head_ref, head_sha: pr.head_sha, checks: status.failing },
        },
      ]);
      detected++;
      await this.startByDaemon(failure_id);
    }
    // Failures that no longer need a fix: closed, moved on, or passing now.
    for (const failure of known.filter((f) => f.status === "open")) {
      if (this.stopped) break;
      const pr = prs.find((p) => p.number === failure.number);
      const reason = !pr ? (prs.length >= LISTING_LIMIT ? undefined : "closed") : pr.head_sha !== failure.head_sha ? "moved" : await this.passes(project.repo, failure.head_sha);
      if (reason) store.append([{ type: "ci.failure.resolved", run_id: null, task_id: null, actor: watcher, payload: { failure_id: failure.id, reason } }]);
    }
    return detected;
  }

  private async passes(repo: string, sha: string): Promise<"passed" | undefined> {
    const status = await this.deps.github.checkStatus(repo, sha);
    return status.pending === 0 && status.failing.length === 0 ? "passed" : undefined;
  }

  /** With `ci_fix.auto`, starts the run within the daily limit; a refusal or failure leaves the failure open. */
  private async startByDaemon(id: string): Promise<void> {
    const { config, store, policy } = this.deps;
    if (!config.ci_fix.auto) return;
    const now = new Date((this.deps.now ?? Date.now)());
    const since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const decision = policy.decide(auto, "ci.auto_fix", id, {
      autonomyLevel: config.autonomy_level,
      usage: { items: store.autoCiFixesSince(since), usd: 0 },
      cap: { items: config.ci_fix.daily_runs, usd: 0 },
    });
    if (decision.effect !== "allow") return;
    const failure = store.getCiFailure(id);
    if (!failure) return;
    await this.startFix(failure, auto, undefined, true).catch(() => {});
  }
}
