import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ApprovalView, NavarchEvent, RunDetail, RunView, StopResult } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude, type FakeScenario } from "../../../packages/adapters/claude-code/test/fake.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";

const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
});

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };

function repo(autonomy: number): string {
  const dir = makeRepo();
  mkdirSync(join(dir, ".navarch"));
  writeFileSync(join(dir, ".navarch", "project.yaml"), `autonomy_level: ${autonomy}\nverify:\n  - name: greeting\n    run: "true"\n`);
  execFileSync("git", ["add", "."], { cwd: dir, env: gitEnv });
  execFileSync("git", ["commit", "-q", "-m", "cfg"], { cwd: dir, env: gitEnv });
  return dir;
}

async function start(scenario: FakeScenario, extra: Record<string, unknown> = {}) {
  const home = tempHome();
  const fake = fakeClaude(scenario);
  const config = Config.parse({ daemon: { port: 0 }, routing: { enabled: false }, ...extra });
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

async function waitFor<T>(fn: () => Promise<T> | T, done: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const statusChanges = (events: NavarchEvent[]) =>
  events.filter((e): e is NavarchEvent<"run.status_changed"> => e.type === "run.status_changed").map((e) => `${e.payload.from}>${e.payload.to}:${e.payload.reason ?? ""}`);

describe("pause, resume and the kill switch (ADR 0020)", () => {
  it("pauses a running agent without using an attempt and resumes its session in the status it had", async () => {
    const { api, fake, daemon } = await start("slow", { scheduler: { max_attempts: 1 } });
    const run = (await api<RunView>("POST", "/api/v1/runs", { repo_path: repo(3), prompt: "slow work" })).body;
    await waitFor(() => existsSync(join(fake.stateDir, "started")), Boolean);
    const task = (await api<RunDetail>("GET", `/api/v1/runs/${run.id}`)).body.tasks.find((t) => t.status === "running")!;

    const paused = await api<RunView>("POST", `/api/v1/runs/${run.id}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe("paused");
    // The interrupted attempt is back in the queue, but nothing is dispatched while paused.
    await waitFor(() => daemon.store.getTask(task.id)!, (t) => t.status === "ready");
    await new Promise((r) => setTimeout(r, 300));
    expect(daemon.store.getTask(task.id)!.status).toBe("ready");
    expect(fake.calls()).toHaveLength(1);
    expect((await api("POST", `/api/v1/runs/${run.id}/pause`)).status).toBe(409);

    const resumed = await api<RunView>("POST", `/api/v1/runs/${run.id}/resume`);
    expect(resumed.body.status).toBe("executing");
    await waitFor(() => api<RunDetail>("GET", `/api/v1/runs/${run.id}`), (r) => r.body.status === "done");

    const calls = fake.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toContain("--resume");
    // max_attempts is 1: the resumed attempt ran because the pause did not count.
    expect(daemon.store.getTask(task.id)).toMatchObject({ attempt: 2, instruction_interrupts: 1 });
    const events = daemon.store.events({ runId: run.id });
    expect(statusChanges(events)).toContain("executing>paused:user");
    expect(statusChanges(events)).toContain("paused>executing:resumed by user");
    const reasons = events
      .filter((e): e is NavarchEvent<"task.status_changed"> => e.type === "task.status_changed" && (e.payload as { to: string }).to === "interrupted")
      .map((e) => e.payload.reason);
    expect(reasons).toEqual(["pause"]);
  });

  it("keeps an approved task waiting while its run is paused", async () => {
    const { api, fake } = await start("flow");
    const run = (await api<RunView>("POST", "/api/v1/runs", { repo_path: repo(1), prompt: "add a greeting" })).body;
    const [approval] = (await waitFor(() => api<ApprovalView[]>("GET", "/api/v1/approvals?status=pending"), (r) => r.body.length > 0)).body;
    const before = (await api<RunView>("GET", `/api/v1/runs/${run.id}`)).body.status;

    expect((await api<RunView>("POST", `/api/v1/runs/${run.id}/pause`)).body.status).toBe("paused");
    await api("POST", `/api/v1/approvals/${approval!.id}`, { decision: "approve" });
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.calls()).toHaveLength(0);
    expect((await api<RunView>("GET", `/api/v1/runs/${run.id}`)).body.status).toBe("paused");

    expect((await api<RunView>("POST", `/api/v1/runs/${run.id}/resume`)).body.status).toBe(before);
    await waitFor(() => fake.calls().length, (n) => n === 1);
  });

  it("stops every active run with the kill switch and records it", async () => {
    const { api, daemon } = await start("flow");
    const a = (await api<RunView>("POST", "/api/v1/runs", { repo_path: repo(1), prompt: "one" })).body;
    const b = (await api<RunView>("POST", "/api/v1/runs", { repo_path: repo(1), prompt: "two" })).body;
    await waitFor(() => api<ApprovalView[]>("GET", "/api/v1/approvals?status=pending"), (r) => r.body.length >= 2);
    await api("POST", `/api/v1/runs/${b.id}/cancel`);

    const stop = await api<StopResult>("POST", "/api/v1/stop");
    expect(stop.status).toBe(200);
    expect(stop.body.paused).toEqual([a.id]);
    expect((await api<RunView>("GET", `/api/v1/runs/${a.id}`)).body.status).toBe("paused");
    const stopped = daemon.store.events().filter((e) => e.type === "fleet.stopped");
    expect(stopped.map((e) => e.payload)).toEqual([{ run_ids: [a.id] }]);
    expect(statusChanges(daemon.store.events({ runId: a.id })).some((s) => s.endsWith(">paused:kill switch"))).toBe(true);
  });

  it("refuses pause and resume from anyone but the user", async () => {
    const { api, daemon } = await start("flow");
    const run = (await api<RunView>("POST", "/api/v1/runs", { repo_path: repo(1), prompt: "one" })).body;
    const agent = { kind: "agent", profile: "implementer", adapter: "claude-code" } as const;
    expect(() => daemon.orchestrator.pauseRun(run.id, agent, () => false)).toThrow(/only the user/);
    expect(daemon.store.events({ runId: run.id }).some((e) => e.type === "policy.denied")).toBe(true);
    expect((await api("POST", "/api/v1/runs/run_missing/pause")).status).toBe(404);
  });
});
