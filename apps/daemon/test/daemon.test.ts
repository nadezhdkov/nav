import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunDetail, RunView, VectrEvent } from "@vectr/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude, type FakeScenario } from "../../../packages/adapters/claude-code/test/fake.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";

const daemons: Daemon[] = [];

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
});

async function startDaemon(home: string, scenario: FakeScenario, fake = fakeClaude(scenario)) {
  const config = Config.parse({ daemon: { port: 0 }, scheduler: { concurrency: 2, max_attempts: 3 } });
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

describe("vectrd", () => {
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
    expect(task).toMatchObject({ status: "succeeded", attempt: 1, branch: `vectr/${created.body.id}/implement` });
    expect(task?.sandbox_path?.startsWith(join(home, "worktrees"))).toBe(true);
    expect(run.body.cost_total).toBeCloseTo(0.01);
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);

    const diff = run.body.artifacts.find((a) => a.kind === "diff");
    expect(diff?.summary).toContain("hello.txt");
    const content = await api<string>("GET", `/api/v1/artifacts/${diff?.id}`);
    expect(content.body).toContain("+hello from fake claude");

    const events = await api<VectrEvent[]>("GET", `/api/v1/runs/${created.body.id}/events`);
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

    const events = await second.api<VectrEvent[]>("GET", `/api/v1/runs/${created.body.id}/events`);
    const transitions = events.body
      .filter((e) => e.type === "task.status_changed")
      .map((e) => `${(e.payload as { from: string }).from}->${(e.payload as { to: string }).to}`);
    expect(transitions).toEqual(["pending->ready", "ready->running", "running->interrupted", "interrupted->ready", "ready->running", "running->succeeded"]);
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

    const failing = await startDaemon(tempHome(), "fail");
    const b = await failing.api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "x" });
    const runB = await waitFor(() => failing.api<RunDetail>("GET", `/api/v1/runs/${b.body.id}`), (r) => r.body.status === "failed");
    expect(runB.body.tasks[0]).toMatchObject({ status: "failed", attempt: 1 });
    expect(runB.body.tasks[0]?.error).toContain("fatal");
  });

  it("redacts secrets from logs and events", async () => {
    const repo = makeRepo();
    const { api } = await startDaemon(tempHome(), "secret");
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "x" });
    await waitFor(() => api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`), (r) => r.body.status === "done");
    const logs = await api<string>("GET", `/api/v1/runs/${created.body.id}/logs`);
    const events = await api<VectrEvent[]>("GET", `/api/v1/runs/${created.body.id}/events`);
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
