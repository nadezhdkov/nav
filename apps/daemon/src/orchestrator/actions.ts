import { createHash } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskOutcome } from "@navarch/agent-runtime";
import { DEFAULT_SCRUB_ENV, scrubbedEnv } from "@navarch/adapter-kit";
import {
  newId,
  parseReviewDraft,
  redact,
  VerificationReport,
  type Actor,
  type ErrorKind,
  type NewEvent,
  type CompeteTaskRef,
  type CompeteView,
  type SandboxHandle,
  type WorkItem,
} from "@navarch/contracts";
import { changedFiles, commitAll, concludeMerge, createWorktree, diffRightLines, fullPullRequestDiff, mergeBranch, worktreeFileDiff, worktreeStatus } from "@navarch/runner";
import { matchesPath, verify } from "@navarch/verification";
import type { Config } from "../config.ts";
import type { EventStore, RunRecord, TaskRecord } from "../events/store.ts";
import type { GitHubIntegration } from "../github/integration.ts";
import type { ActionExecutor } from "../scheduler/scheduler.ts";
import { prBody, prTitle, type PrBodyInput } from "./issue.ts";
import { ownsWorktree } from "./worktrees.ts";

type Deps = { home: string; config: Config; store: EventStore; github: GitHubIntegration };

const runner: Actor = { kind: "system", component: "runner" };
const github: Actor = { kind: "system", component: "github" };

/** Executors for the non-agent nodes a Flow can use, keyed by `uses` (spec §6.6, §6.7, §7.1). */
export function buildActions(deps: Deps): Map<string, ActionExecutor> {
  return new Map([
    ["verification.run", verifyNode(deps)],
    ["pr.create", openPrNode(deps)],
    ["pr.review", reviewPrNode(deps)],
    ["pr.comment", commentPrNode(deps)],
    ["team.integrate", integrateNode(deps)],
    ["compete.compare", compareNode(deps)],
    ["compete.adopt", adoptNode(deps)],
    ["approval", approvalNode(deps)],
  ]);
}

/**
 * A human gate (spec §6.2.1 `approval`): the policy always asks; once approved there is nothing
 * left to do but record the option the approver picked, if the gate offered choices (ADR 0031).
 */
function approvalNode(deps: Deps): ActionExecutor {
  return {
    action: "flow.approval",
    describe: (_run, task) => {
      const shown = Object.entries(task.inputs);
      if (!shown.length) return `Continue the run past "${task.node_id}".`;
      return [`Continue the run past "${task.node_id}" after reviewing:`, ...shown.map(([path, text]) => `\n--- ${path} ---\n${text}`)].join("\n");
    },
    async execute({ task }) {
      const choice = task.choices?.length ? (deps.store.decidedChoice(task.id) ?? task.choices[0]) : undefined;
      const outputs = { approved: true, ...(choice !== undefined ? { choice } : {}) };
      return { status: "succeeded", summary: choice !== undefined ? `approved: ${choice}` : "approved", artifacts: [], claims: [], usage: [], outputs, cost: 0, durationMs: 0 };
    },
  };
}

function verifyNode(deps: Deps): ActionExecutor {
  return {
    action: "verification.run",
    describe: (run) => `Run ${run.verify.length} verify command(s) in the run's worktree: ${run.verify.map((c) => c.run).join("; ")}`,
    async execute({ run, task, attempt, signal }) {
      const started = Date.now();
      // A competitor's checks run in its own worktree (ADR 0031).
      const sandbox = task.compete?.key ? competitorSandbox(deps.store, run, task.compete) : implementSandbox(deps.store, run);
      const log = await openLog(deps.home, run.id, task.id, attempt);
      try {
        const files = await changedFiles(sandbox);
        const report = await verify({
          cwd: sandbox.path,
          checks: run.verify,
          changedFiles: files,
          protectedPaths: run.protected_paths,
          env: scrubbedEnv(DEFAULT_SCRUB_ENV),
          timeoutMs: deps.config.scheduler.task_timeout_minutes * 60_000,
          onOutput: (chunk) => log.write(chunk),
          signal,
        });
        if (signal.aborted) return failed("cancelled", "verification cancelled", started);
        const artifactId = await saveArtifact(deps, run.id, task.id, "report", JSON.stringify(report, null, 2), summarise(report));
        publish(deps.store, run.id, task.id, runner, "verification.completed", { ...report, artifact_id: artifactId });
        // The check ran: the task succeeds and the Flow decides (fix loop, or fail the run).
        // Runs created before Flows have no loop, so a failed report still fails them.
        if (!report.passed && !run.flow_definition) {
          return failed("fatal", `verification failed: ${report.blocking_failures.join("; ")}`, started, [artifactId]);
        }
        const summary = report.passed ? summarise(report) : `verification failed: ${report.blocking_failures.join("; ")}`;
        return {
          status: "succeeded",
          summary,
          artifacts: [artifactId],
          claims: [],
          usage: [],
          outputs: { passed: report.passed, blocking_failures: report.blocking_failures, warnings: report.warnings },
          cost: 0,
          durationMs: Date.now() - started,
        };
      } finally {
        await new Promise<void>((resolve) => log.end(resolve));
      }
    },
  };
}

/**
 * Merges a parallel team member's branch into the run's worktree (ADR 0029). The first attempt
 * merges, leaving a conflict in progress for an implementer; the second, after it, concludes the
 * merge when the markers are gone and aborts it otherwise. The result is the task's output.
 */
function integrateNode(deps: Deps): ActionExecutor {
  return {
    action: "team.integrate",
    describe: (run, task) => `Merge team member ${task.inputs.member ?? "?"}'s branch into the run's worktree (${sharedSandbox(deps.store, run).branch}).`,
    async execute({ run, task }) {
      const started = Date.now();
      const key = task.team?.key ?? task.inputs.member;
      const member = deps.store.taskRecordsOfRun(run.id).filter((t) => task.team && t.node_id === `${task.team.node_id}.${key}` && t.sandbox_path && t.branch).at(-1);
      if (!key || !member) return failed("fatal", `no worktree for team member ${key}`, started);
      const target = sharedSandbox(deps.store, run);
      const source = { path: member.sandbox_path!, branch: member.branch! };
      try {
        const result = task.iteration > 1
          ? await concludeMerge({ repoPath: run.repo_path, target, source, files: conflictsOf(deps.store, task) })
          : await mergeBranch({ repoPath: run.repo_path, target, source, message: `Merge team member ${key}: ${task.inputs.title ?? key}` });
        const summary = result.merged ? `merged ${source.branch}` : `${task.iteration > 1 ? "not merged" : "merge conflict"}: ${result.conflicts.join(", ")}`;
        return { status: "succeeded", summary, artifacts: [], claims: [], usage: [], outputs: { ...result }, cost: 0, durationMs: Date.now() - started };
      } catch (err) {
        return failed("fatal", redact(err instanceof Error ? err.message : String(err)), started);
      }
    },
  };
}

/** Each finalist's diff in the judge's prompt is cut at this many characters (ADR 0031). */
export const COMPETITOR_DIFF_CAP = 12_000;

/**
 * Measures each finalist of a compete node from its fork point (ADR 0031): files changed with
 * lines added and removed, protected paths touched, fix iterations and the diff, cut when long.
 * It reads git without touching any index, so the judge gets facts, not the competitors' claims.
 */
function compareNode(deps: Deps): ActionExecutor {
  return {
    action: "compete.compare",
    describe: (_run, task) => `Compare the finalists of ${task.compete?.node_id ?? "the compete node"} (${listInput(task.inputs.finalists).join(", ")}).`,
    async execute({ run, task }) {
      const started = Date.now();
      const ref = task.compete;
      if (!ref) return failed("fatal", "not a compete task", started);
      try {
        const finalists = [];
        for (const key of listInput(task.inputs.finalists)) {
          const sandbox = competitorSandbox(deps.store, run, { ...ref, key });
          const status = await worktreeStatus(sandbox.path, sandbox.baseCommit);
          let diff = "";
          for (const file of status.files) {
            if (diff.length >= COMPETITOR_DIFF_CAP) break;
            diff += await worktreeFileDiff(sandbox.path, sandbox.baseCommit, file, COMPETITOR_DIFF_CAP);
          }
          const iterations = deps.store.taskRecordsOfRun(run.id).filter((t) => t.node_id === `${ref.node_id}.${key}`).reduce((n, t) => Math.max(n, t.iteration), 0);
          finalists.push({
            key,
            iterations,
            files: status.files.map((f) => `${f.status} ${f.path}${f.added === null ? " (binary)" : ` +${f.added} −${f.removed}`}`),
            added: status.totals.added,
            removed: status.totals.removed,
            protected_paths: status.files.map((f) => f.path).filter((path) => run.protected_paths.some((pattern) => matchesPath(pattern, path))),
            diff: redact(diff.length > COMPETITOR_DIFF_CAP ? `${diff.slice(0, COMPETITOR_DIFF_CAP)}\n[cut: ${diff.length - COMPETITOR_DIFF_CAP} more characters]` : diff),
          });
        }
        const summary = finalists.map((f) => `${f.key}: ${f.files.length} file(s), +${f.added} −${f.removed}${f.protected_paths.length ? `, protected: ${f.protected_paths.join(", ")}` : ""}`).join("; ");
        return { status: "succeeded", summary, artifacts: [], claims: [], usage: [], outputs: { finalists }, cost: 0, durationMs: Date.now() - started };
      } catch (err) {
        return failed("fatal", redact(err instanceof Error ? err.message : String(err)), started);
      }
    },
  };
}

/**
 * Merges the winning competitor's branch into the run's shared worktree (ADR 0031), creating that
 * worktree when no earlier task did. Nothing edits the shared worktree while competitors work, so
 * the merge does not conflict; a conflict all the same fails the task and leaves nothing half-done.
 */
function adoptNode(deps: Deps): ActionExecutor {
  return {
    action: "compete.adopt",
    describe: (run, task) => `Merge the winning competitor ${task.inputs.winner ?? "?"}'s branch into the run's worktree (navarch/${run.id}/${run.flow_definition?.definition.metadata.name ?? "?"}).`,
    async execute({ run, task }) {
      const started = Date.now();
      const ref = task.compete;
      const winner = task.inputs.winner;
      if (!ref || !winner) return failed("fatal", "no winner to adopt", started);
      try {
        const source = competitorSandbox(deps.store, run, { ...ref, key: winner });
        const target = await sharedOrNew(deps, run, task);
        const message = `Adopt competitor ${winner}`;
        const result = await mergeBranch({ repoPath: run.repo_path, target, source, message });
        if (!result.merged) return failed("fatal", `adopting ${winner} conflicted in ${result.conflicts.join(", ")}`, started);
        return { status: "succeeded", summary: `merged ${source.branch}`, artifacts: [], claims: [], usage: [], outputs: { merged: true, winner, branch: source.branch }, cost: 0, durationMs: Date.now() - started };
      } catch (err) {
        return failed("fatal", redact(err instanceof Error ? err.message : String(err)), started);
      }
    },
  };
}

/** The run's shared worktree, created now (and recorded on this task) when no earlier task made it. */
async function sharedOrNew(deps: Deps, run: RunRecord, task: TaskRecord): Promise<SandboxHandle> {
  const existing = deps.store.taskRecordsOfRun(run.id).find((t) => t.sandbox_path && t.branch && !ownsWorktree(t));
  if (existing) return { id: existing.sandbox_id ?? "", kind: "worktree", path: existing.sandbox_path!, branch: existing.branch!, baseCommit: run.base_commit };
  const slug = run.flow_definition?.definition.metadata.name;
  if (!slug) throw new Error(`run ${run.id} has no Flow`);
  const handle = await createWorktree({ sandboxId: newId("sbx"), repoPath: run.repo_path, runId: run.id, taskSlug: slug, baseCommit: run.base_commit, home: deps.home });
  publish(deps.store, run.id, task.id, runner, "sandbox.created", { sandbox_id: handle.id, kind: handle.kind, path: handle.path, branch: handle.branch, base_commit: handle.baseCommit, reused: handle.reused });
  return handle;
}

/** A competitor's own worktree, measured from where it forked. */
function competitorSandbox(store: EventStore, run: RunRecord, ref: CompeteTaskRef): SandboxHandle {
  const tasks = store.taskRecordsOfRun(run.id).filter((t) => t.node_id === `${ref.node_id}.${ref.key}` && t.sandbox_path && t.branch);
  const task = tasks.at(-1);
  if (!task) throw new Error(`no worktree for competitor ${ref.key}`);
  const forked = store
    .events({ runId: run.id })
    .filter((e) => e.type === "sandbox.created" && tasks.some((t) => t.id === e.task_id))
    .map((e) => (e.payload as { base_commit?: string }).base_commit)
    .find((c) => c);
  return { id: task.sandbox_id ?? "", kind: "worktree", path: task.sandbox_path!, branch: task.branch!, baseCommit: forked ?? run.base_commit };
}

/** A list input rendered as `- a` lines. */
function listInput(text: string | undefined): string[] {
  return (text ?? "").split("\n").map((l) => l.replace(/^- /, "").trim()).filter(Boolean);
}

/** The files the first integration of this member left in conflict. */
function conflictsOf(store: EventStore, task: TaskRecord): string[] {
  const first = store.taskRecordsOfRun(task.run_id).find((t) => t.node_id === task.node_id && t.iteration === 1);
  const conflicts = first?.outputs?.conflicts;
  return Array.isArray(conflicts) ? conflicts.map(String) : [];
}

function openPrNode(deps: Deps): ActionExecutor {
  return {
    action: "github.pr.create",
    describe: (run) => {
      const item = workItem(deps.store, run);
      const branch = implementTask(deps.store, run).branch;
      if (item.pull_request) return `Commit what the agent left uncommitted, push ${branch} and open a draft PR on ${item.repo} into ${item.pull_request.head_ref}, the branch of pull request #${item.number}: "${prTitle(item)}".`;
      return `Commit what the agent left uncommitted, push ${branch} and open a draft PR on ${item.repo} for issue #${item.number}: "${prTitle(item)}".`;
    },
    async execute({ run, task, signal }) {
      const started = Date.now();
      const item = workItem(deps.store, run);
      const impl = implementTask(deps.store, run);
      const sandbox = implementSandbox(deps.store, run);
      const winner = adoptedWinner(deps.store, run);
      try {
        await commitAll(sandbox, `${prTitle(item)}\n\nFixes #${item.number}\n\nCommitted by Navarch for run ${run.id}.`);
        if (signal.aborted) return failed("cancelled", "cancelled before push", started);
        const level = deps.config.autonomy_level;
        const commit = await deps.github.push(sandbox.path, item.repo, sandbox.branch, level);
        publish(deps.store, run.id, task.id, github, "github.push", { repo: item.repo, branch: sandbox.branch, commit });
        const pr = await deps.github.openDraftPr({
          repo: item.repo,
          head: sandbox.branch,
          // A ci-fix PR goes into the pull request's own branch (ADR 0032).
          ...(item.pull_request ? { base: item.pull_request.head_ref } : {}),
          title: prTitle(item),
          body: redact(
            prBody({
              item,
              summary: impl.summary ?? "",
              plan: latestSummary(deps.store, run.id, "planner"),
              review: latestSummary(deps.store, run.id, "reviewer"),
              agents: {
                planner: agentOf(deps.store, run.id, "planner"),
                implementer: winner ? agentOfTask(deps.store, run.id, winner.task) : agentOf(deps.store, run.id, "implementer"),
                reviewer: agentOf(deps.store, run.id, "reviewer"),
              },
              iterations: impl.iteration,
              changedFiles: await changedFiles({ ...sandbox }),
              // In a compete run, the checks of the competitor whose work the PR carries.
              report: latestReport(deps.store, run.id, winner?.verifyTaskId),
              ...(winner ? { compete: competeSection(deps.store, run, winner.view) } : {}),
              cost: run.cost_total,
              models: modelsUsed(deps.store, run.id),
              runId: run.id,
            }),
          ),
        });
        publish(deps.store, run.id, task.id, github, "github.pr.opened", { repo: item.repo, number: pr.number, url: pr.url, branch: sandbox.branch, draft: true });
        return { status: "succeeded", summary: `Draft PR ${pr.url}`, artifacts: [], claims: [], usage: [], cost: 0, durationMs: Date.now() - started };
      } catch (err) {
        const message = redact(err instanceof Error ? err.message : String(err));
        // Network and 5xx failures can succeed on retry; a refused token or a denied push cannot.
        const transient = /fetch failed|ECONNRESET|ETIMEDOUT|returned 5\d\d/.test(message);
        return failed(transient ? "transient" : "fatal", message, started);
      }
    },
  };
}

/** The hidden line that tells a retried post its earlier review or comment (ADR 0032). */
const marker = (runId: string) => `<!-- navarch:${runId} -->`;

/** What `pr.review` would post: the review's text, the inline comments, and the count of all comments. */
function reviewToPost(store: EventStore, run: RunRecord, anchorable?: Map<string, Set<number>>): { body: string; comments: { path: string; line: number; body: string }[]; total: number } {
  const text = latestSummary(store, run.id, "pr-reviewer") ?? "";
  const parsed = parseReviewDraft(text);
  const verdicts = { comment: "Comments", approve: "Looks good to merge (the reviewer's opinion; a human decides)", request_changes: "Changes suggested" };
  if (!parsed.ok) return { body: [text.trim() || "_The reviewer gave no summary._", "", footer(run, "review")].join("\n"), comments: [], total: 0 };
  const { review } = parsed;
  const inline = review.comments.filter((c) => !anchorable || anchorable.get(c.path)?.has(c.line));
  const others = review.comments.filter((c) => !inline.includes(c));
  const body = [
    review.summary,
    "",
    `**Verdict:** ${verdicts[review.verdict]}`,
    ...(others.length ? ["", "### Other notes", "", ...others.map((c) => `- \`${c.path}:${c.line}\`: ${c.body.replace(/\n/g, " ")}`)] : []),
    "",
    footer(run, "review"),
  ].join("\n");
  return { body, comments: inline, total: review.comments.length };
}

function footer(run: RunRecord, what: "review" | "diagnosis"): string {
  return `_${what === "review" ? "Review" : "Diagnosis"} drafted by Navarch run \`${run.id}\` and posted as a comment; a human decides._\n${marker(run.id)}`;
}

/**
 * Posts the `pr-reviewer`'s draft as one COMMENT review on the reviewed head commit (ADR 0032):
 * inline comments on lines the diff shows, the rest in the text. Never approves or requests changes.
 */
function reviewPrNode(deps: Deps): ActionExecutor {
  return {
    action: "github.pr.review",
    describe: (run) => {
      const item = workItem(deps.store, run);
      const { body, total } = reviewToPost(deps.store, run);
      return `Post this review on ${item.repo}#${item.number} as a comment (never an approval), with ${total} line comment(s); those on lines outside the diff go into the text:\n\n${body}${total ? `\n\n--- line comments ---\n${listComments(deps.store, run)}` : ""}`;
    },
    async execute({ run, task }) {
      const started = Date.now();
      const item = workItem(deps.store, run);
      const pr = item.pull_request;
      if (!pr) return failed("fatal", "pr.review needs a run on a pull request", started);
      try {
        const lines = diffRightLines(await fullPullRequestDiff(run.repo_path, pr.base_sha, pr.head_sha));
        const { body, comments } = reviewToPost(deps.store, run, lines);
        const posted = await deps.github.postReview({ repo: item.repo, number: item.number, commit_id: pr.head_sha, body: redact(body), comments: comments.map((c) => ({ ...c, body: redact(c.body) })), marker: marker(run.id) });
        publish(deps.store, run.id, task.id, github, "github.review.posted", { repo: item.repo, number: item.number, url: posted.url, commit: pr.head_sha, comments: comments.length, existing: posted.existing });
        return { status: "succeeded", summary: `Review posted: ${posted.url}`, artifacts: [], claims: [], usage: [], outputs: { url: posted.url }, cost: 0, durationMs: Date.now() - started };
      } catch (err) {
        return githubFailure(err, started);
      }
    },
  };
}

function listComments(store: EventStore, run: RunRecord): string {
  const parsed = parseReviewDraft(latestSummary(store, run.id, "pr-reviewer") ?? "");
  return parsed.ok ? parsed.review.comments.map((c) => `${c.path}:${c.line}: ${c.body}`).join("\n") : "";
}

/** Posts the `ci-fixer`'s diagnosis on the pull request as one comment, changing no code (ADR 0032). */
function commentPrNode(deps: Deps): ActionExecutor {
  const text = (run: RunRecord) => {
    const diagnosis = (latestSummary(deps.store, run.id, "ci-fixer") ?? "").replace(/```navarch-outputs[\s\S]*?```/g, "").trim();
    return [diagnosis || "_The diagnosis is empty._", "", footer(run, "diagnosis")].join("\n");
  };
  return {
    action: "github.pr.comment",
    describe: (run) => {
      const item = workItem(deps.store, run);
      return `Post this comment on ${item.repo}#${item.number}; no code changes:\n\n${text(run)}`;
    },
    async execute({ run, task }) {
      const started = Date.now();
      const item = workItem(deps.store, run);
      try {
        const posted = await deps.github.postComment({ repo: item.repo, number: item.number, body: redact(text(run)), marker: marker(run.id) });
        publish(deps.store, run.id, task.id, github, "github.comment.posted", { repo: item.repo, number: item.number, url: posted.url, existing: posted.existing });
        return { status: "succeeded", summary: `Comment posted: ${posted.url}`, artifacts: [], claims: [], usage: [], outputs: { url: posted.url }, cost: 0, durationMs: Date.now() - started };
      } catch (err) {
        return githubFailure(err, started);
      }
    },
  };
}

/** Network and 5xx failures can succeed on retry; a refused token or a denied write cannot. */
function githubFailure(err: unknown, started: number): TaskOutcome {
  const message = redact(err instanceof Error ? err.message : String(err));
  return failed(/fetch failed|ECONNRESET|ETIMEDOUT|returned 5\d\d/.test(message) ? "transient" : "fatal", message, started);
}

/**
 * The latest implementer task, which holds the run's worktree and the change's summary; in a
 * compete run, the adopted winner's (ADR 0031).
 */
function implementTask(store: EventStore, run: RunRecord): TaskRecord {
  const tasks = store.taskRecordsOfRun(run.id);
  const task = adoptedWinner(store, run)?.task ?? tasks.filter((t) => t.profile === "implementer" && t.status === "succeeded").at(-1) ?? tasks.find((t) => t.node_id === "implement");
  // The run's own worktree, not a parallel member's (ADR 0029).
  const sandbox = tasks.find((t) => t.sandbox_path && t.branch && !ownsWorktree(t));
  if (!task || !sandbox) throw new Error(`run ${run.id} has no implement worktree`);
  return { ...task, sandbox_id: sandbox.sandbox_id, sandbox_path: sandbox.sandbox_path, branch: sandbox.branch };
}

/** The competitor a compete run adopted: its latest task, its latest checks, and the run's compete view. */
function adoptedWinner(store: EventStore, run: RunRecord): { task: TaskRecord; verifyTaskId: string | undefined; view: CompeteView } | undefined {
  const view = store.competeOf(run.id, run.flow_definition);
  if (!view?.adopted || !view.winner) return undefined;
  const tasks = store.taskRecordsOfRun(run.id);
  const task = tasks.filter((t) => t.node_id === `${view.node_id}.${view.winner}` && t.status === "succeeded").at(-1);
  if (!task) return undefined;
  const verifyTaskId = tasks.filter((t) => t.node_id === `${view.node_id}.${view.winner}.verify` && t.status === "succeeded").at(-1)?.id;
  return { task, verifyTaskId, view };
}

/** The PR's Compete section: each competitor's agent, result and the judge's ranking. */
function competeSection(store: EventStore, run: RunRecord, view: CompeteView): NonNullable<PrBodyInput["compete"]> {
  const tasks = store.taskRecordsOfRun(run.id);
  return {
    winner: view.winner!,
    chosen_by: view.chosen_by ?? "judge",
    judge_summary: view.judge_summary,
    judge: view.judge_task_id ? agentOfTask(store, run.id, tasks.find((t) => t.id === view.judge_task_id)!) : undefined,
    competitors: view.competitors.map((c) => {
      const task = tasks.find((t) => t.id === c.task_id);
      return { key: c.key, agent: task ? agentOfTask(store, run.id, task) : undefined, state: c.state, reason: c.reason, rank: c.rank, score: c.score, judge_reason: c.judge_reason };
    }),
  };
}

function latestSummary(store: EventStore, runId: string, profile: string): string | undefined {
  const task = store.taskRecordsOfRun(runId).filter((t) => t.profile === profile && t.status === "succeeded").at(-1);
  return task?.summary ?? undefined;
}

/**
 * "adapter · model" of the agent whose work the PR carries for a profile (its last succeeded task),
 * with the model the agent reported using when the task did not pin one.
 */
function agentOf(store: EventStore, runId: string, profile: string): string | undefined {
  const task = store.taskRecordsOfRun(runId).filter((t) => t.profile === profile && t.status === "succeeded").at(-1);
  return task ? agentOfTask(store, runId, task) : undefined;
}

/** "adapter · model" of one task's agent. */
function agentOfTask(store: EventStore, runId: string, task: TaskRecord): string {
  const reported = store
    .events({ runId })
    .filter((e) => e.type === "model.call.completed" && e.task_id === task.id)
    .map((e) => String((e.payload as { model: string }).model))
    .at(-1);
  const model = task.model ?? reported;
  return model && model !== task.adapter ? `${task.adapter} · ${model}` : task.adapter;
}

function implementSandbox(store: EventStore, run: RunRecord): SandboxHandle {
  const task = implementTask(store, run);
  return { id: task.sandbox_id ?? "", kind: "worktree", path: task.sandbox_path!, branch: task.branch!, baseCommit: run.base_commit };
}

/** The run's shared worktree: the first agent's, never a parallel member's own. */
function sharedSandbox(store: EventStore, run: RunRecord): SandboxHandle {
  const task = store.taskRecordsOfRun(run.id).find((t) => t.sandbox_path && t.branch && !ownsWorktree(t));
  if (!task) throw new Error(`run ${run.id} has no worktree`);
  return { id: task.sandbox_id ?? "", kind: "worktree", path: task.sandbox_path!, branch: task.branch!, baseCommit: run.base_commit };
}

function workItem(store: EventStore, run: RunRecord): WorkItem {
  const event = store.events({ runId: run.id }).find((e) => e.type === "workitem.received");
  if (!event) throw new Error(`run ${run.id} has no work item`);
  return event.payload as WorkItem;
}

function latestReport(store: EventStore, runId: string, taskId?: string): VerificationReport | undefined {
  const event = store.events({ runId }).filter((e) => e.type === "verification.completed" && (!taskId || e.task_id === taskId)).at(-1);
  return event ? VerificationReport.parse(event.payload) : undefined;
}

function modelsUsed(store: EventStore, runId: string): string[] {
  const models = store.events({ runId }).filter((e) => e.type === "model.call.completed").map((e) => String((e.payload as { model: string }).model));
  return [...new Set(models)];
}

function summarise(report: VerificationReport): string {
  const passed = report.checks.filter((c) => c.exit_code === 0).length;
  const head = report.checks.length ? `${passed}/${report.checks.length} checks passed` : "no checks configured";
  return report.warnings.length ? `${head}; ${report.warnings.length} warning(s)` : head;
}

function failed(kind: ErrorKind, message: string, started: number, artifacts: string[] = []): TaskOutcome {
  return { status: "failed", summary: "", artifacts, claims: [], usage: [], error: { kind, message }, cost: 0, durationMs: Date.now() - started };
}

async function openLog(home: string, runId: string, taskId: string, attempt: number): Promise<WriteStream> {
  const dir = join(home, "logs", runId);
  await mkdir(dir, { recursive: true });
  const stream = createWriteStream(join(dir, `${taskId}.log`), { flags: "a" });
  stream.write(`--- attempt ${attempt} ${new Date().toISOString()} ---\n`);
  return stream;
}

async function saveArtifact(deps: Deps, runId: string, taskId: string, kind: "report", content: string, summary: string): Promise<string> {
  const id = newId("art");
  const dir = join(deps.home, "artifacts", runId);
  await mkdir(dir, { recursive: true });
  const uri = join(dir, `${id}.json`);
  await writeFile(uri, content);
  publish(deps.store, runId, taskId, runner, "artifact.created", {
    artifact_id: id,
    kind,
    uri,
    sha256: createHash("sha256").update(content).digest("hex"),
    summary,
  });
  return id;
}

function publish<T extends NewEvent["type"]>(
  store: EventStore,
  runId: string,
  taskId: string,
  actor: Actor,
  type: T,
  payload: Extract<NewEvent, { type: T }>["payload"],
): void {
  store.append([{ type, run_id: runId, task_id: taskId, actor, payload } as NewEvent]);
}
