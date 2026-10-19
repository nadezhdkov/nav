import type { Actor } from "@navarch/contracts";
import { GitHubError } from "@navarch/github";
import type { Config } from "../config.ts";
import type { EventStore } from "../events/store.ts";
import type { GitHubIntegration } from "./integration.ts";

import type { PullRequestRecord } from "../events/store.ts";

const watcher: Actor = { kind: "system", component: "github" };
const TICK_MS = 60_000;
/** A pull request that answers 404 this many polls in a row is no longer followed. */
const MAX_NOT_FOUND = 3;

/**
 * The PR watcher (ADR 0037): follows every pull request Navarch opened until it closes, reading it
 * through the GitHub Integration on the Inbox's schedule, and records how it ended. It only reads.
 */
export class PrWatcher {
  private readonly deps: {
    config: Config;
    store: EventStore;
    github: GitHubIntegration;
    now?: () => number;
    /** Called after a pull request is recorded as merged; a failure here never stops the watcher. */
    onMerged?: (pr: PullRequestRecord) => Promise<void>;
  };
  private readonly notFound = new Map<string, number>();
  private lastPoll = 0;
  private polling: Promise<number> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(deps: PrWatcher["deps"]) {
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

  /** Reads every open pull request once; returns how many closed. One check at a time. */
  check(): Promise<number> {
    this.polling ??= this.checkAll().finally(() => (this.polling = undefined));
    return this.polling;
  }

  private async checkAll(): Promise<number> {
    this.lastPoll = (this.deps.now ?? Date.now)();
    let closed = 0;
    for (const pr of this.deps.store.openPullRequests()) {
      if (this.stopped) break;
      const key = `${pr.repo}#${pr.number}`;
      try {
        const outcome = await this.deps.github.pullRequestOutcome(pr.repo, pr.number, pr.commit_sha);
        this.notFound.delete(key);
        if (!outcome) continue;
        this.deps.store.append([{ type: "github.pr.closed", run_id: pr.run_id, task_id: null, actor: watcher, payload: { repo: pr.repo, number: pr.number, ...outcome } }]);
        closed++;
        if (outcome.merged) await this.deps.onMerged?.(pr).catch(() => {});
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) {
          const misses = (this.notFound.get(key) ?? 0) + 1;
          this.notFound.set(key, misses);
          if (misses >= MAX_NOT_FOUND) {
            this.notFound.delete(key);
            this.deps.store.append([{ type: "github.pr.lost", run_id: pr.run_id, task_id: null, actor: watcher, payload: { repo: pr.repo, number: pr.number, reason: "not found" } }]);
          }
        } else if (err instanceof GitHubError && (err.status === 403 || err.status === 429)) {
          break; // Rate limited: the rest waits for the next poll.
        }
        // Anything else (network, no token) is retried on the next poll.
      }
    }
    return closed;
  }
}
