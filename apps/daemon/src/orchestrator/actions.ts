import { createHash } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskOutcome } from "@navarch/agent-runtime";
import { DEFAULT_SCRUB_ENV, scrubbedEnv } from "@navarch/adapter-kit";
import {
  newId,
  redact,
  VerificationReport,
  type Actor,
  type ErrorKind,
  type NewEvent,
  type SandboxHandle,
  type WorkItem,
} from "@navarch/contracts";
import { changedFiles, commitAll } from "@navarch/runner";
import { verify } from "@navarch/verification";
import type { Config } from "../config.ts";
import type { EventStore, RunRecord, TaskRecord } from "../events/store.ts";
import type { GitHubIntegration } from "../github/integration.ts";
import type { ActionExecutor } from "../scheduler/scheduler.ts";
import { prBody, prTitle } from "./issue.ts";

type Deps = { home: string; config: Config; store: EventStore; github: GitHubIntegration };

const runner: Actor = { kind: "system", component: "runner" };
const github: Actor = { kind: "system", component: "github" };

/** Executors for the non-agent nodes a Flow can use, keyed by `uses` (spec §6.6, §6.7, §7.1). */
export function buildActions(deps: Deps): Map<string, ActionExecutor> {
  return new Map([
    ["verification.run", verifyNode(deps)],
    ["pr.create", openPrNode(deps)],
    ["approval", approvalNode()],
  ]);
}

/** A human gate (spec §6.2.1 `approval`): the policy always asks; once approved there is nothing left to do. */
function approvalNode(): ActionExecutor {
  return {
    action: "flow.approval",
    describe: (_run, task) => {
      const shown = Object.entries(task.inputs);
      if (!shown.length) return `Continue the run past "${task.node_id}".`;
      return [`Continue the run past "${task.node_id}" after reviewing:`, ...shown.map(([path, text]) => `\n--- ${path} ---\n${text}`)].join("\n");
    },
    async execute() {
      return { status: "succeeded", summary: "approved", artifacts: [], claims: [], usage: [], outputs: { approved: true }, cost: 0, durationMs: 0 };
    },
  };
}

function verifyNode(deps: Deps): ActionExecutor {
  return {
    action: "verification.run",
    describe: (run) => `Run ${run.verify.length} verify command(s) in the run's worktree: ${run.verify.map((c) => c.run).join("; ")}`,
    async execute({ run, task, attempt, signal }) {
      const started = Date.now();
      const sandbox = implementSandbox(deps.store, run);
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

function openPrNode(deps: Deps): ActionExecutor {
  return {
    action: "github.pr.create",
    describe: (run) => {
      const item = workItem(deps.store, run);
      const branch = implementTask(deps.store, run).branch;
      return `Commit what the agent left uncommitted, push ${branch} and open a draft PR on ${item.repo} for issue #${item.number}: "${prTitle(item)}".`;
    },
    async execute({ run, task, signal }) {
      const started = Date.now();
      const item = workItem(deps.store, run);
      const impl = implementTask(deps.store, run);
      const sandbox = implementSandbox(deps.store, run);
      try {
        await commitAll(sandbox, `${prTitle(item)}\n\nFixes #${item.number}\n\nCommitted by Navarch for run ${run.id}.`);
        if (signal.aborted) return failed("cancelled", "cancelled before push", started);
        const level = deps.config.autonomy_level;
        const commit = await deps.github.push(sandbox.path, item.repo, sandbox.branch, level);
        publish(deps.store, run.id, task.id, github, "github.push", { repo: item.repo, branch: sandbox.branch, commit });
        const pr = await deps.github.openDraftPr({
          repo: item.repo,
          head: sandbox.branch,
          title: prTitle(item),
          body: redact(
            prBody({
              item,
              summary: impl.summary ?? "",
              plan: latestSummary(deps.store, run.id, "planner"),
              review: latestSummary(deps.store, run.id, "reviewer"),
              iterations: impl.iteration,
              changedFiles: await changedFiles({ ...sandbox }),
              report: latestReport(deps.store, run.id),
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

/** The latest implementer task, which holds the run's worktree and the change's summary. */
function implementTask(store: EventStore, run: RunRecord): TaskRecord {
  const tasks = store.taskRecordsOfRun(run.id);
  const task = tasks.filter((t) => t.profile === "implementer" && t.status === "succeeded").at(-1) ?? tasks.find((t) => t.node_id === "implement");
  const sandbox = tasks.find((t) => t.sandbox_path && t.branch);
  if (!task || !sandbox) throw new Error(`run ${run.id} has no implement worktree`);
  return { ...task, sandbox_id: sandbox.sandbox_id, sandbox_path: sandbox.sandbox_path, branch: sandbox.branch };
}

function latestSummary(store: EventStore, runId: string, profile: string): string | undefined {
  const task = store.taskRecordsOfRun(runId).filter((t) => t.profile === profile && t.status === "succeeded").at(-1);
  return task?.summary ?? undefined;
}

function implementSandbox(store: EventStore, run: RunRecord): SandboxHandle {
  const task = implementTask(store, run);
  return { id: task.sandbox_id ?? "", kind: "worktree", path: task.sandbox_path!, branch: task.branch!, baseCommit: run.base_commit };
}

function workItem(store: EventStore, run: RunRecord): WorkItem {
  const event = store.events({ runId: run.id }).find((e) => e.type === "workitem.received");
  if (!event) throw new Error(`run ${run.id} has no work item`);
  return event.payload as WorkItem;
}

function latestReport(store: EventStore, runId: string): VerificationReport | undefined {
  const event = store.events({ runId }).filter((e) => e.type === "verification.completed").at(-1);
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
