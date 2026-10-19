import { AUTO_MERGE_CONDITIONS, type Actor, type AutoMergeStatus, type AutoMergeView, type SetAutoMergeRequest, VerificationReport } from "@navarch/contracts";
import { matchesPath } from "@navarch/verification";
import { loadProjectConfig } from "../project.ts";
import type { Config } from "../config.ts";
import type { EventStore, PullRequestRecord } from "../events/store.ts";
import type { PolicyEngine } from "../policy/engine.ts";
import type { GitHubIntegration, MergeFacts } from "./integration.ts";

const system: Actor = { kind: "system", component: "automerge" };
const TICK_MS = 60_000;

export class AutoMergeError extends Error {
  readonly code: "not_found" | "bad_request" | "conflict" | "forbidden";

  constructor(code: AutoMergeError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** Files that change what a project depends on or how its CI runs: never merged without a human (spec §11.1). */
const DEPENDENCY_FILES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "requirements.txt", "pyproject.toml", "poetry.lock", "Pipfile", "Pipfile.lock", "uv.lock", "setup.py", "setup.cfg",
  "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "Gemfile", "Gemfile.lock", "composer.json", "composer.lock",
  "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "gradle.lockfile", "Package.swift", "Package.resolved", "mix.exs", "mix.lock",
]);

/** The file the check is about, with why; undefined when it is fine to merge past. */
export function sensitiveFile(file: string, protectedPaths: readonly string[]): string | undefined {
  const name = file.split("/").pop() ?? file;
  if (DEPENDENCY_FILES.has(name) || /^requirements.*\.txt$/.test(name)) return `${file} is a dependency manifest or lockfile`;
  if (file.startsWith(".github/workflows/")) return `${file} is a CI workflow`;
  if (protectedPaths.some((pattern) => matchesPath(pattern, file))) return `${file} is a protected path`;
  return undefined;
}

/**
 * Opt-in auto-merge (spec §11.1, ADR 0060). On a schedule it looks at the open pull requests Navarch
 * opened in projects where the user turned it on, and merges one only when every condition holds;
 * otherwise it remembers why not. The setting lives in events the user caused, never in the
 * repository, and the kill switch turns it off. Merging is decided by the Policy Engine.
 */
export class AutoMerger {
  private readonly deps: { config: Config; store: EventStore; policy: PolicyEngine; github: Pick<GitHubIntegration, "mergeFacts" | "autoMerge">; now?: () => number };
  private readonly waiting = new Map<string, { number: number; url: string; reason: string; at: number }>();
  private readonly lastCheck = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<number> | undefined;
  private off: (() => void) | undefined;

  constructor(deps: AutoMerger["deps"]) {
    this.deps = deps;
  }

  start(): void {
    this.timer = setInterval(() => void this.check().catch(() => {}), TICK_MS);
    this.timer.unref();
    // The kill switch (spec §11.1) turns auto-merge off everywhere before anything else.
    this.off = this.deps.store.subscribe((event) => {
      if (event.type === "fleet.stopped") this.disableAll("kill switch");
    });
  }

  async stop(): Promise<void> {
    this.off?.();
    this.off = undefined;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => {});
  }

  status(): AutoMergeStatus {
    const settings = this.deps.store.autoMergeSettings();
    const projects: AutoMergeView[] = this.deps.store.listProjects().map((p) => {
      const s = settings.get(p.id);
      return {
        project_id: p.id,
        repo: p.repo,
        enabled: s?.enabled ?? false,
        strategy: s?.strategy ?? "squash",
        since: s?.since ?? null,
        waiting: [...this.waiting.entries()].filter(([key]) => key.startsWith(`${p.repo}#`)).map(([, w]) => ({ number: w.number, url: w.url, reason: w.reason })),
      };
    });
    return { conditions: [...AUTO_MERGE_CONDITIONS], projects };
  }

  /**
   * The user turns auto-merge on or off. Turning it on needs the repository's name typed back
   * (`confirm`), and the project's autonomy level to be 3 or higher; a phone or an agent never gets here
   * because the Policy Engine decided `automerge.set` before.
   */
  async set(projectId: string, req: SetAutoMergeRequest, actor: Actor): Promise<AutoMergeView> {
    const decision = this.deps.policy.decide(actor, "automerge.set", projectId, { autonomyLevel: this.deps.config.autonomy_level });
    if (decision.effect !== "allow") throw new AutoMergeError("forbidden", decision.reason);
    const project = this.deps.store.getProject(projectId);
    if (!project || project.removed_at) throw new AutoMergeError("not_found", `no project ${projectId}`);
    const current = this.deps.store.autoMergeSettings().get(project.id);
    if (req.enabled) {
      if (req.confirm?.trim().toLowerCase() !== project.repo.toLowerCase()) throw new AutoMergeError("bad_request", `to turn auto-merge on, confirm it by typing the repository name: ${project.repo}`);
      const level = (await loadProjectConfig(project.path, "HEAD").catch(() => ({ autonomy_level: undefined }))).autonomy_level ?? this.deps.config.autonomy_level;
      if (level < 3) throw new AutoMergeError("conflict", `auto-merge needs autonomy level 3 or higher on ${project.repo}; it is ${level} (autonomy_level in the daemon config or in .navarch/project.yaml)`);
      if (!current?.enabled || (req.strategy && req.strategy !== current.strategy)) {
        this.deps.store.append([{ type: "github.auto_merge.enabled", run_id: null, task_id: null, actor, payload: { project_id: project.id, repo: project.repo, strategy: req.strategy ?? "squash" } }]);
      }
    } else if (current?.enabled) {
      this.deps.store.append([{ type: "github.auto_merge.disabled", run_id: null, task_id: null, actor, payload: { project_id: project.id, repo: project.repo, reason: "turned off by the user" } }]);
    }
    return this.status().projects.find((p) => p.project_id === project.id)!;
  }

  private disableAll(reason: string): void {
    for (const [projectId, s] of this.deps.store.autoMergeSettings()) {
      if (!s.enabled) continue;
      const project = this.deps.store.getProject(projectId);
      this.deps.store.append([{ type: "github.auto_merge.disabled", run_id: null, task_id: null, actor: system, payload: { project_id: projectId, repo: project?.repo ?? "", reason } }]);
    }
  }

  /** Looks at every open PR of Navarch's in a project with auto-merge on; returns how many it merged. One pass at a time. */
  check(): Promise<number> {
    this.running ??= this.checkAll().finally(() => (this.running = undefined));
    return this.running;
  }

  private async checkAll(): Promise<number> {
    const { store, config } = this.deps;
    const now = (this.deps.now ?? Date.now)();
    const settings = store.autoMergeSettings();
    const enabled = new Map(store.listProjects().filter((p) => !p.removed_at && settings.get(p.id)?.enabled).map((p) => [p.repo.toLowerCase(), { project: p, strategy: settings.get(p.id)!.strategy }]));
    if (!enabled.size) return 0;
    let merged = 0;
    const open = store.openPullRequests();
    for (const key of [...this.waiting.keys()]) if (!open.some((p) => `${p.repo}#${p.number}` === key)) this.waiting.delete(key);
    for (const pr of open) {
      const entry = enabled.get(pr.repo.toLowerCase());
      if (!entry) continue;
      const key = `${pr.repo}#${pr.number}`;
      if (now - (this.lastCheck.get(key) ?? 0) < Math.max(1, config.inbox.poll_minutes) * 60_000 / 2) continue;
      this.lastCheck.set(key, now);
      try {
        const reason = await this.consider(pr, entry.strategy);
        if (reason === undefined) {
          merged++;
          this.waiting.delete(key);
        } else this.waiting.set(key, { number: pr.number, url: pr.url, reason, at: now });
      } catch (err) {
        this.waiting.set(key, { number: pr.number, url: pr.url, reason: `could not check: ${(err as Error).message}`.slice(0, 300), at: now });
      }
    }
    return merged;
  }

  /** Why a pull request is not merged yet, or undefined after merging it. Local conditions first, GitHub's after. */
  private async consider(pr: PullRequestRecord, method: "squash" | "merge" | "rebase"): Promise<string | undefined> {
    const { store } = this.deps;
    const run = store.getRunRecord(pr.run_id);
    if (!run) return "its run is gone";
    if (run.status !== "pr_opened") return `the run is ${run.status}, not pr_opened`;
    if (run.flow === "ci-fix") return "ci-fix pull requests target another pull request's branch";
    if ((run.autonomy_level ?? this.deps.config.autonomy_level) < 3) return "the run's autonomy level is below 3";
    if (!/^navarch\//.test(pr.branch)) return "the branch is not a navarch/* branch";
    if (run.cost_total > run.budget) return "the run's billed cost is over its budget";

    const report = latestReport(store, run.id);
    if (!report) return "no verification report";
    if (!report.passed) return "the verification failed";
    if (!report.checks.length) return "the verification ran no checks (the project defines none)";
    const changedProtected = report.warnings.find((w) => w.startsWith("protected path changed"));
    if (changedProtected) return changedProtected;

    const reviewer = store.taskRecordsOfRun(run.id).filter((t) => t.profile === "reviewer" && t.status === "succeeded").at(-1);
    if (!reviewer) return "the Flow has no succeeded review";
    const out = reviewer.outputs ?? {};
    if (out.verdict !== "approve") return `the reviewer's verdict is ${String(out.verdict ?? "missing")}`;
    if (out.blocking !== 0) return "the reviewer reported blocking findings, or did not say how many";
    if (out.red !== 0) return "the reviewer reported 🔴 items, or did not say how many";

    const pushed = store.events({ runId: run.id }).filter((e) => e.type === "github.push").at(-1)?.payload as { commit: string; branch: string } | undefined;
    if (!pushed || pushed.branch !== pr.branch) return "Navarch did not push this branch in the run";

    const facts = await this.deps.github.mergeFacts(pr.repo, pr.number);
    const gh = githubReason(facts, pr, pushed.commit, run.protected_paths);
    if (gh) return gh;

    // The setting may have changed while GitHub was being read.
    const setting = store.autoMergeSettings();
    const project = store.listProjects().find((p) => p.repo.toLowerCase() === pr.repo.toLowerCase());
    if (!project || !setting.get(project.id)?.enabled) return "auto-merge was turned off";
    const done = await this.deps.github.autoMerge(
      { repo: pr.repo, number: pr.number, sha: facts.head_sha, node_id: facts.node_id, draft: facts.draft, title: facts.title, method },
      { autonomyLevel: run.autonomy_level ?? this.deps.config.autonomy_level, enabled: true },
    );
    store.append([{ type: "github.pr.merged", run_id: run.id, task_id: null, actor: system, payload: { repo: pr.repo, number: pr.number, sha: facts.head_sha, merge_sha: done.sha, method, auto: true } }]);
    return undefined;
  }
}

/** What GitHub says that stops the merge; undefined when it all holds. */
export function githubReason(facts: MergeFacts, pr: { branch: string; repo: string }, pushedCommit: string, protectedPaths: readonly string[]): string | undefined {
  if (facts.state !== "open" || facts.merged) return "the pull request is no longer open";
  if (facts.head_repo.toLowerCase() !== pr.repo.toLowerCase()) return "the pull request comes from a fork";
  if (facts.head_ref !== pr.branch) return "the pull request's head branch changed";
  if (facts.head_sha !== pushedCommit) return "the head is not the commit Navarch pushed";
  if (facts.base_ref !== facts.default_branch) return `the target ${facts.base_ref} is not the default branch ${facts.default_branch}`;
  if (facts.base_protected) return `the target branch ${facts.base_ref} is protected on GitHub; auto-merge never targets a protected branch`;
  if (facts.files_truncated) return "the pull request changes too many files to check";
  for (const file of facts.files) {
    const why = sensitiveFile(file, protectedPaths);
    if (why) return why;
  }
  if (facts.checks.total === 0) return "GitHub shows no check runs for the head (CI must be green and cannot be skipped)";
  if (facts.checks.pending > 0) return `${facts.checks.pending} check(s) still running`;
  if (facts.checks.notGreen.length) return `checks not green: ${facts.checks.notGreen.slice(0, 3).join(", ")}`;
  return undefined;
}

function latestReport(store: EventStore, runId: string): VerificationReport | undefined {
  const event = store.events({ runId }).filter((e) => e.type === "verification.completed").at(-1);
  return event ? VerificationReport.parse(event.payload) : undefined;
}
