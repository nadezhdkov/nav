import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunDetail, RunView, WorktreeStatus } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";

const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
});

async function start() {
  const home = tempHome();
  const config = Config.parse({ daemon: { port: 0 }, routing: { enabled: false }, autonomy_level: 3 });
  const daemon = new Daemon({ home, config, adapters: { "claude-code": fakeClaude("edit").options } });
  await daemon.start();
  daemons.push(daemon);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = async <T>(path: string, auth = true): Promise<{ status: number; body: T }> => {
    const res = await fetch(daemon.url + path, { headers: auth ? { authorization: `Bearer ${token}` } : {} });
    const text = await res.text();
    return { status: res.status, body: (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) as T };
  };
  const post = async <T>(path: string, body: unknown): Promise<T> =>
    (await (await fetch(daemon.url + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as T;
  return { daemon, api, post };
}

async function finished(api: Awaited<ReturnType<typeof start>>["api"], id: string): Promise<RunDetail> {
  const end = Date.now() + 15_000;
  for (;;) {
    const run = (await api<RunDetail>(`/api/v1/runs/${id}`)).body;
    if (["done", "failed", "cancelled"].includes(run.status)) return run;
    if (Date.now() > end) throw new Error(`run still ${run.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("worktree API (slice 10)", () => {
  it("lists the run's changed files and one file's diff, read-only", async () => {
    const { api, post } = await start();
    const repo = makeRepo();
    const run = await post<RunView>("/api/v1/runs", { repo_path: repo, prompt: "add hello" });
    const detail = await finished(api, run.id);
    const sandbox = detail.tasks.find((t) => t.sandbox_path)!.sandbox_path!;
    writeFileSync(join(sandbox, "notes.md"), "one\ntwo\n");
    const before = execFileSync("git", ["status", "--porcelain=v2"], { cwd: sandbox }).toString();

    const status = await api<WorktreeStatus>(`/api/v1/runs/${run.id}/worktree`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ run_id: run.id, path: sandbox, base_commit: detail.base_commit, exists: true });
    expect(status.body.branch).toMatch(/^navarch\//);
    expect(status.body.files).toContainEqual({ path: "notes.md", status: "untracked", added: 2, removed: 0 });
    expect(status.body.totals.files).toBe(status.body.files.length);

    const diff = await api<string>(`/api/v1/runs/${run.id}/worktree/diff?path=notes.md`);
    expect(diff.status).toBe(200);
    expect(diff.body).toContain("+two");
    for (const path of ["README.md", "../../etc/passwd", "", "%2Fetc%2Fpasswd"]) {
      expect((await api(`/api/v1/runs/${run.id}/worktree/diff?path=${path}`)).status, path).toBe(404);
    }
    expect(execFileSync("git", ["status", "--porcelain=v2"], { cwd: sandbox }).toString()).toBe(before);

    expect((await api(`/api/v1/runs/${run.id}/worktree`, false)).status).toBe(401);
    expect((await api("/api/v1/runs/run_nope/worktree")).status).toBe(404);

    rmSync(sandbox, { recursive: true, force: true });
    expect((await api<WorktreeStatus>(`/api/v1/runs/${run.id}/worktree`)).body).toMatchObject({ exists: false, files: [], totals: { files: 0, added: 0, removed: 0 } });
    expect((await api(`/api/v1/runs/${run.id}/worktree/diff?path=notes.md`)).status).toBe(404);
  });
});
