import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalView, RunDetail, RunView } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";

const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
});

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };

/** A repository whose check passes once answer.txt exists. */
function repo(autonomy: number): string {
  const dir = makeRepo();
  mkdirSync(join(dir, ".navarch"));
  writeFileSync(join(dir, ".navarch", "project.yaml"), `autonomy_level: ${autonomy}\nverify:\n  - name: answer\n    run: test -f answer.txt\n`);
  execFileSync("git", ["add", "."], { cwd: dir, env: gitEnv });
  execFileSync("git", ["commit", "-q", "-m", "cfg"], { cwd: dir, env: gitEnv });
  return dir;
}

async function start() {
  const home = tempHome();
  const claude = fakeClaude("compete");
  const config = Config.parse({ daemon: { port: 0 }, routing: { tiers: { fast: ["claude-code"], standard: ["claude-code"], expert: ["claude-code"] } } });
  const daemon = new Daemon({ home, config, adapters: { "claude-code": claude.options } });
  await daemon.start();
  daemons.push(daemon);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(daemon.url + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { api, claude };
}

async function waitFor<T>(fn: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const end = Date.now() + 15_000;
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const tasksOf = (d: RunDetail) => JSON.stringify(d.tasks.map((t) => [t.node_id, t.iteration, t.status, t.error]));

describe("compete runs (ADR 0031)", () => {
  it("needs an explicit run budget", async () => {
    const { api } = await start();
    const res = await api<{ error: string; message: string }>("POST", "/api/v1/runs", { repo_path: repo(3), prompt: "write answer.txt", flow: "compete" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("budget_required");
    const param = await api<{ error: string; message: string }>("POST", "/api/v1/runs", { repo_path: repo(3), prompt: "x", flow: "compete", budget: 1, params: { competitors: "many" } });
    expect(param.body.message).toBe('param "competitors" of flow "compete" must be an integer');
    const unknown = await api<{ message: string }>("POST", "/api/v1/runs", { repo_path: repo(3), prompt: "x", flow: "compete", budget: 1, params: { judges: 2 } });
    expect(unknown.body.message).toBe('flow "compete" has no param "judges"; params: competitors, max_fix_iterations');
  });

  it("three competitors in their own worktrees, one out; the judge ranks the rest and the user picks another winner", async () => {
    const { api, claude } = await start();
    const run = (
      await api<RunView>("POST", "/api/v1/runs", { repo_path: repo(2), prompt: "write answer.txt", flow: "compete", budget: 2, params: { competitors: "3", max_fix_iterations: "1" } })
    ).body;
    expect(run.status).not.toBe("failed");

    const pending = await waitFor(
      () => api<ApprovalView[]>("GET", "/api/v1/approvals?status=pending"),
      (r) => r.body.some((a) => a.run_id === run.id),
    );
    const pick = pending.body.find((a) => a.run_id === run.id)!;
    expect(pick.choices).toEqual(["c2", "c1"]);
    expect(pick.summary).toContain("c2 wins on size.");
    expect(pick.summary).toContain("1. c2 (8/10): c2 is the smaller change.");

    // Each competitor worked in its own worktree; c3 never passed its check.
    const cwds = claude.calls().filter((c) => c.prompt.includes("You are the Navarch implementer agent")).map((c) => c.cwd.split("-").at(-1)).sort();
    expect(cwds).toEqual(["c1", "c2", "c3"]);
    let detail = (await api<RunDetail>("GET", `/api/v1/runs/${run.id}`)).body;
    // The run stays in reviewing while the pick waits (spec §8.4 has no way back to awaiting_approval).
    expect(detail.status).toBe("reviewing");
    expect(detail.compete!.competitors.map((c) => [c.key, c.state, c.rank, c.branch])).toEqual([
      ["c1", "finalist", 2, `navarch/${run.id}/compete-c1`],
      ["c2", "finalist", 1, `navarch/${run.id}/compete-c2`],
      ["c3", "out", null, `navarch/${run.id}/compete-c3`],
    ]);
    expect(detail.compete!.competitors[2]!.reason).toBe("checks still failed after 1 iteration(s): answer: `test -f answer.txt` exited with 1");
    expect(detail.tasks.find((t) => t.node_id === "compete.judge")!.summary).toContain("I read both diffs");

    // Only one of the offered choices, and only when approving.
    expect((await api("POST", `/api/v1/approvals/${pick.id}`, { decision: "approve", choice: "c3" })).status).toBe(400);
    expect((await api("POST", `/api/v1/approvals/${pick.id}`, { decision: "reject", choice: "c1" })).status).toBe(400);
    const decided = await api<ApprovalView>("POST", `/api/v1/approvals/${pick.id}`, { decision: "approve", choice: "c1" });
    expect(decided.body).toMatchObject({ status: "approved", choice: "c1" });

    detail = (await waitFor(() => api<RunDetail>("GET", `/api/v1/runs/${run.id}`), (r) => ["done", "failed"].includes(r.body.status))).body;
    expect(detail.status, tasksOf(detail)).toBe("done");
    expect(detail.compete).toMatchObject({ winner: "c1", chosen_by: "user", adopted: true });

    // The run's branch carries the winner's work, not the judge's pick.
    const shared = (await api<{ path: string; branch: string; files: { path: string }[] }>("GET", `/api/v1/runs/${run.id}/worktree`)).body;
    expect(shared.branch).toBe(`navarch/${run.id}/compete`);
    expect(shared.files.map((f) => f.path).sort()).toEqual(["answer.txt", "c1.txt"]);
    expect(readFileSync(join(shared.path, "answer.txt"), "utf8")).toBe("c1\n");
    expect(existsSync(join(shared.path, "c2.txt"))).toBe(false);
    expect(git(shared.path, "log", "-1", "--format=%an %s")).toBe("Navarch Adopt competitor c1\n");
    // The reviewer read why the winner won.
    const review = claude.calls().find((c) => c.prompt.includes("You are the Navarch reviewer agent"))!;
    expect(review.prompt).toContain("Chosen by the user over the judge's c2");
  });

  it("adopts the judge's pick at autonomy 3, without asking", async () => {
    const { api, claude } = await start();
    const run = (await api<RunView>("POST", "/api/v1/runs", { repo_path: repo(3), prompt: "write answer.txt", flow: "compete", budget: 2, params: { max_fix_iterations: 1 } })).body;
    const detail = (await waitFor(() => api<RunDetail>("GET", `/api/v1/runs/${run.id}`), (r) => ["done", "failed"].includes(r.body.status))).body;
    expect(detail.status, tasksOf(detail)).toBe("done");
    expect(detail.compete).toMatchObject({ winner: "c2", chosen_by: "judge", judge_summary: "c2 wins on size.", adopted: true });
    expect(detail.tasks.some((t) => t.node_id === "compete.approve_pick")).toBe(false);
    expect(claude.calls().filter((c) => c.prompt.includes("You are the Navarch judge agent"))).toHaveLength(1);
  });
});
