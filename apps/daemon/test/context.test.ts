import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunDetail, RunView } from "@navarch/contracts";
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

function repo(): string {
  const dir = makeRepo();
  mkdirSync(join(dir, ".navarch"));
  writeFileSync(join(dir, ".navarch", "project.yaml"), "autonomy_level: 3\nverify:\n  - name: greeting\n    run: test -f hello.txt\n");
  execFileSync("git", ["add", "."], { cwd: dir, env: gitEnv });
  execFileSync("git", ["commit", "-q", "-m", "cfg"], { cwd: dir, env: gitEnv });
  return dir;
}

async function start(knowledge: { context: { enabled: boolean } }) {
  const home = tempHome();
  const fake = fakeClaude("edit");
  const daemon = new Daemon({ home, config: Config.parse({ daemon: { port: 0 }, routing: { enabled: false }, knowledge }), adapters: { "claude-code": fake.options } });
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
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  const waitRun = async (id: string): Promise<RunDetail> => {
    const end = Date.now() + 15_000;
    for (;;) {
      const r = (await api<RunDetail>("GET", `/api/v1/runs/${id}`)).body;
      if (r.status === "done" || r.status === "failed") return r;
      if (Date.now() > end) throw new Error(`timed out in ${r.status}`);
      await new Promise((res) => setTimeout(res, 50));
    }
  };
  return { api, fake, waitRun };
}

describe("compiled context in the prompt", () => {
  it("adds a context block after the task and records its size, when enabled", async () => {
    const { api, fake, waitRun } = await start({ context: { enabled: true } });
    const dir = repo();
    writeFileSync(join(dir, "greet.ts"), "export function greetWorld() {\n  return 'hello';\n}\n");
    execFileSync("git", ["add", "."], { cwd: dir, env: gitEnv });
    execFileSync("git", ["commit", "-q", "-m", "add greet"], { cwd: dir, env: gitEnv });
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: dir, prompt: "change `greetWorld` to say hi" });
    const run = await waitRun(created.body.id);
    expect(run.status).toBe("done");

    const prompt = fake.calls()[0]!.prompt!;
    expect(prompt).toContain("<context>");
    expect(prompt).toContain("greet.ts:1");
    expect(prompt.indexOf("<context>")).toBeGreaterThan(prompt.indexOf("</task>"));
    const events = (await api<{ type: string; payload: { est_tokens: number; sources: string[] } }[]>("GET", `/api/v1/runs/${created.body.id}/events`)).body;
    const compiled = events.find((e) => e.type === "context.compiled");
    expect(compiled?.payload.est_tokens).toBeGreaterThan(0);
    expect(compiled?.payload.sources).toContain("greet.ts:1");
  });

  it("leaves the prompt unchanged when disabled", async () => {
    const { api, fake, waitRun } = await start({ context: { enabled: false } });
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo(), prompt: "write hello.txt" });
    await waitRun(created.body.id);
    expect(fake.calls()[0]!.prompt).not.toContain("<context>");
    const events = (await api<{ type: string }[]>("GET", `/api/v1/runs/${created.body.id}/events`)).body;
    expect(events.some((e) => e.type === "context.compiled")).toBe(false);
  });
});
