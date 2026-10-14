import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunDetail, RunView, NavarchEvent } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude, type FakeScenario } from "../../../packages/adapters/claude-code/test/fake.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";

const daemons: Daemon[] = [];

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
});

async function startDaemon(home: string, scenario: FakeScenario, fake = fakeClaude(scenario), concurrency = 2) {
  // Rate-limit waits without a reset hint last 60 ms here instead of minutes.
  const config = Config.parse({ daemon: { port: 0 }, scheduler: { concurrency, max_attempts: 3, rate_limit_backoff_minutes: [0.001] } });
  const daemon = new Daemon({ home, config, adapters: { "claude-code": fake.options } });
  await daemon.start();
  daemons.push(daemon);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(daemon.url + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) as T };
  };
  return { daemon, api, fake };
}

async function waitFor<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("navarchd", () => {
  it("tells the agent exactly which commands it may run", async () => {
    const { api, fake } = await startDaemon(tempHome(), "edit");
    const created = await api<RunView>("POST", "/api/v1/runs", {
      repo_path: makeRepo(),
      prompt: "add hello.txt",
      allow_commands: ["uv run pytest *", "make check"],
    });
    await waitFor(
      () => api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`),
      (r) => r.body.status === "done",
    );
    const prompt = fake.calls()[0]?.prompt ?? "";
    expect(prompt).toContain("- `uv run pytest` followed by any arguments");
    expect(prompt).toContain("- `make check` exactly");
    expect(prompt).toContain("- `git status` exactly");
    expect(prompt.indexOf("make check")).toBeLessThan(prompt.indexOf("<task>"));
  });

  it("runs the setup commands in the worktree before the agent", async () => {
    const { api, fake } = await startDaemon(tempHome(), "edit");
    const created = await api<RunView>("POST", "/api/v1/runs", {
      repo_path: makeRepo(),
      prompt: "add hello.txt",
      setup_commands: ["test -f README.md && echo ready"],
    });
    const run = await waitFor(
      () => api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`),
      (r) => r.body.status === "done",
    );
    const events = (await api<NavarchEvent[]>("GET", `/api/v1/runs/${created.body.id}/events`)).body;
    const setup = events.find((e) => e.type === "sandbox.setup");
    expect(setup?.payload).toMatchObject({ command: "test -f README.md && echo ready", exit_code: 0 });
    const order = events.map((e) => e.type);
    expect(order.indexOf("sandbox.setup")).toBeLessThan(order.indexOf("task.progress"));
    expect(fake.calls()).toHaveLength(1);
    expect(run.body.tasks[0]?.status).toBe("succeeded");
  });

  it("fails the task without starting the agent when a setup command fails", async () => {
    const { api, fake } = await startDaemon(tempHome(), "edit");
    const created = await api<RunView>("POST", "/api/v1/runs", {
      repo_path: makeRepo(),
      prompt: "add hello.txt",
      setup_commands: ["echo cannot install >&2; exit 3"],
    });
    const run = await waitFor(
      () => api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`),
      (r) => r.body.status === "failed",
    );
    expect(run.body.tasks[0]?.error).toContain("setup command failed");
    expect(run.body.tasks[0]?.error).toContain("cannot install");
    expect(run.body.tasks[0]?.attempt).toBe(1);
    expect(fake.calls()).toEqual([]);
  });

  it("cancels a task during setup without starting the agent", async () => {
    const marker = join(tempHome(), "setup-started");
    const { api, fake } = await startDaemon(tempHome(), "edit");
    const created = await api<RunView>("POST", "/api/v1/runs", {
      repo_path: makeRepo(),
      prompt: "add hello.txt",
      setup_commands: [`touch '${marker}'; sleep 30; echo done`],
    });
    await waitFor(async () => existsSync(marker), (v) => v);

    await api("POST", `/api/v1/runs/${created.body.id}/cancel`);
    const run = await waitFor(
      () => api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`),
      (r) => r.body.tasks[0]?.status === "cancelled",
      5_000,
    );
    expect(run.body.status).toBe("cancelled");
    expect(fake.calls()).toEqual([]);
  });

  it("stops promptly while a setup command runs, and the task starts again on restart", async () => {
    const marker = join(tempHome(), "setup-started");
    const home = tempHome();
    const first = await startDaemon(home, "edit");
    const created = await first.api<RunView>("POST", "/api/v1/runs", {
      repo_path: makeRepo(),
      prompt: "add hello.txt",
      setup_commands: [`touch '${marker}'; sleep 30; echo done`],
    });
    await waitFor(async () => existsSync(marker), (v) => v);

    const started = Date.now();
    await first.daemon.stop();
    daemons.splice(daemons.indexOf(first.daemon), 1);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(first.fake.calls()).toEqual([]);

    const second = await startDaemon(home, "edit");
    const run = await second.api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`);
    expect(run.body.status).not.toBe("cancelled");
    await second.api("POST", `/api/v1/runs/${created.body.id}/cancel`);
  });

  it("rejects requests without the local token", async () => {
    const { daemon } = await startDaemon(tempHome(), "edit");
    expect((await fetch(`${daemon.url}/api/v1/runs`)).status).toBe(401);
  });

  it("runs a task in a worktree end to end and records the diff", async () => {
    const repo = makeRepo();
    const home = tempHome();
    const { api } = await startDaemon(home, "edit");

    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "add hello.txt", budget: 1 });
    expect(created.status).toBe(201);
    const run = await waitFor(
      () => api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`),
      (r) => r.body.status === "done",
    );

    const [task] = run.body.tasks;
    expect(task).toMatchObject({ status: "succeeded", attempt: 1, branch: `navarch/${created.body.id}/task` });
    expect(task?.sandbox_path?.startsWith(join(home, "worktrees"))).toBe(true);
    expect(run.body.cost_total).toBeCloseTo(0.01);
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);

    const diff = run.body.artifacts.find((a) => a.kind === "diff");
    expect(diff?.summary).toContain("hello.txt");
    const content = await api<string>("GET", `/api/v1/artifacts/${diff?.id}`);
    expect(content.body).toContain("+hello from fake claude");

    const events = await api<NavarchEvent[]>("GET", `/api/v1/runs/${created.body.id}/events`);
    const types = events.body.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["run.created", "sandbox.created", "task.progress", "task.completed", "artifact.created"]));
    expect(types.at(-1)).toBe("run.status_changed");
    const denied = events.body.find((e) => e.type === "policy.denied");
    expect(denied?.payload).toMatchObject({ action: "tool.Bash", resource: "Bash python3 check.py" });

    const logs = await api<string>("GET", `/api/v1/runs/${created.body.id}/logs`);
    expect(logs.body).toContain('"type":"result"');
  });

  it("resumes an interrupted task after the daemon restarts (Phase 0 go/no-go)", async () => {
    const repo = makeRepo();
    const home = tempHome();
    const fake = fakeClaude("slow");
    const first = await startDaemon(home, "slow", fake);

    const created = await first.api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "long job" });
    await waitFor(async () => existsSync(join(fake.stateDir, "started")), (v) => v);
    await waitFor(
      () => first.api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`),
      (r) => r.body.tasks[0]?.status === "running",
    );
    await first.daemon.stop();
    daemons.splice(daemons.indexOf(first.daemon), 1);

    const second = await startDaemon(home, "slow", fake);
    const run = await waitFor(
      () => second.api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`),
      (r) => r.body.status === "done",
    );
    expect(run.body.tasks[0]).toMatchObject({ status: "succeeded", attempt: 2 });

    const calls = fake.calls();
    expect(calls).toHaveLength(2);
    const sessionId = calls[0]!.args[calls[0]!.args.indexOf("--session-id") + 1];
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["--resume", sessionId]));
    expect(calls[1]!.cwd).toBe(calls[0]!.cwd);
    expect(existsSync(join(calls[0]!.cwd, "partial.txt"))).toBe(true);
    expect(existsSync(join(calls[0]!.cwd, "resumed.txt"))).toBe(true);

    const events = await second.api<NavarchEvent[]>("GET", `/api/v1/runs/${created.body.id}/events`);
    const transitions = (taskId: string | undefined) =>
      events.body
        .filter((e) => e.type === "task.status_changed" && e.task_id === taskId)
        .map((e) => `${(e.payload as { from: string }).from}->${(e.payload as { to: string }).to}`);
    expect(transitions(run.body.tasks[0]?.id)).toEqual([
      "pending->ready",
      "ready->running",
      "running->interrupted",
      "interrupted->ready",
      "ready->running",
      "running->succeeded",
    ]);
    // Verification runs once the implement task is done.
    expect(transitions(run.body.tasks[1]?.id)).toEqual(["pending->ready", "ready->running", "running->succeeded"]);
  });

  it("after a restart, dispatches interrupted tasks before tasks that never started", async () => {
    const repo = makeRepo();
    const home = tempHome();
    const fake = fakeClaude("slow");
    const first = await startDaemon(home, "slow", fake, 1);

    const interrupted = await first.api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "long job" });
    await waitFor(async () => existsSync(join(fake.stateDir, "started")), (v) => v);
    const queued = await first.api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "queued job" });
    await first.daemon.stop();
    daemons.splice(daemons.indexOf(first.daemon), 1);

    const second = await startDaemon(home, "slow", fake, 1);
    await waitFor(async () => fake.calls().length, (n) => n >= 2);
    const afterRestart = fake.calls()[1];
    expect(afterRestart?.args).toContain("--resume");
    const run = await second.api<RunDetail>("GET", `/api/v1/runs/${interrupted.body.id}`);
    expect(run.body.tasks[0]?.attempt).toBe(2);
    // The queued task runs the 60 s "slow" scenario; do not wait for it.
    await second.api("POST", `/api/v1/runs/${queued.body.id}/cancel`);
  });

  it("cancels a running run", async () => {
    const repo = makeRepo();
    const { api, fake } = await startDaemon(tempHome(), "slow");
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "long job" });
    await waitFor(async () => existsSync(join(fake.stateDir, "started")), (v) => v);

    const cancelled = await api<RunView>("POST", `/api/v1/runs/${created.body.id}/cancel`);
    expect(cancelled.body.status).toBe("cancelled");
    const run = await waitFor(
      () => api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`),
      (r) => r.body.tasks[0]?.status === "cancelled",
    );
    expect(run.body.status).toBe("cancelled");
    expect((await api("POST", `/api/v1/runs/${created.body.id}/cancel`)).status).toBe(409);
  });

  it("retries a rate-limited task and fails a fatal one without retry", async () => {
    const repo = makeRepo();
    const limited = await startDaemon(tempHome(), "ratelimit-once");
    const a = await limited.api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "x" });
    const runA = await waitFor(() => limited.api<RunDetail>("GET", `/api/v1/runs/${a.body.id}`), (r) => r.body.status === "done");
    expect(runA.body.tasks[0]?.attempt).toBe(2);
    const waited = limited.daemon.store.events({ runId: a.body.id }).find((e) => e.type === "task.status_changed" && "not_before" in e.payload);
    expect(waited?.payload).toMatchObject({ from: "failed", to: "ready", reason: expect.stringContaining("waiting for claude-code quota") });

    const failing = await startDaemon(tempHome(), "fail");
    const b = await failing.api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "x" });
    const runB = await waitFor(() => failing.api<RunDetail>("GET", `/api/v1/runs/${b.body.id}`), (r) => r.body.status === "failed");
    expect(runB.body.tasks[0]).toMatchObject({ status: "failed", attempt: 1 });
    expect(runB.body.tasks[0]?.error).toContain("fatal");
  });

  it("waits for the reset time the agent reported, without spending attempts", async () => {
    const repo = makeRepo();
    const { daemon, api } = await startDaemon(tempHome(), "limit-once");
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "x" });
    const run = await waitFor(() => api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`), (r) => r.body.status === "done");
    expect(run.body.tasks[0]).toMatchObject({ status: "succeeded", attempt: 2, not_before: null });

    const events = daemon.store.events({ runId: created.body.id });
    const wait = events.find((e) => e.type === "task.status_changed" && "not_before" in e.payload);
    const failure = events.find((e) => e.type === "task.status_changed" && (e.payload as { to: string }).to === "failed");
    // The fake's five-hour window resets 1 s after the failure; the scheduler adds a 5 s margin.
    const resetAt = Date.parse((failure!.payload as { error: { retry_at: string } }).error.retry_at);
    expect(Date.parse((wait!.payload as { not_before: string }).not_before)).toBe(resetAt + 5_000);
    expect(events.filter((e) => e.type === "quota.observed").map((e) => e.payload)).toContainEqual(
      expect.objectContaining({ adapter: "claude-code", window: "five_hour", utilization: 1, exhausted: true }),
    );
  }, 20_000);

  it("pauses a run whose quota resets too far away, and resumes it on request", async () => {
    const repo = makeRepo();
    const { api, fake } = await startDaemon(tempHome(), "limit-weekly");
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "x" });
    const paused = await waitFor(() => api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`), (r) => r.body.status === "paused");
    expect(paused.body.tasks[0]).toMatchObject({ status: "failed", attempt: 1 });

    expect((await api("POST", `/api/v1/runs/${created.body.id}/resume`)).body).toMatchObject({ status: "executing" });
    // The weekly fake is still limited, so the run pauses again after one more attempt.
    const again = await waitFor(
      () => api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`),
      (r) => r.body.status === "paused" && r.body.tasks[0]?.attempt === 2,
    );
    expect(again.body.tasks[0]?.status).toBe("failed");
    expect(fake.calls()).toHaveLength(2);
    expect((await api("POST", `/api/v1/runs/${run404()}/resume`)).status).toBe(404);
  });

  it("redacts secrets from logs and events", async () => {
    const repo = makeRepo();
    const { api } = await startDaemon(tempHome(), "secret");
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "x" });
    await waitFor(() => api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`), (r) => r.body.status === "done");
    const logs = await api<string>("GET", `/api/v1/runs/${created.body.id}/logs`);
    const events = await api<NavarchEvent[]>("GET", `/api/v1/runs/${created.body.id}/events`);
    expect(logs.body).not.toContain("ghp_");
    expect(JSON.stringify(events.body)).not.toContain("ghp_");
    expect(logs.body).toContain("[REDACTED]");
  });

  it("rejects a path that is not a git repository", async () => {
    const { api } = await startDaemon(tempHome(), "edit");
    const res = await api<{ error: string }>("POST", "/api/v1/runs", { repo_path: tempHome(), prompt: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_repo");
  });
});

function run404(): string {
  return "run_00000000000000000000000000";
}
