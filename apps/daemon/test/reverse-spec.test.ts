import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NavarchEvent, RunDetail, RunView, SpecRunView } from "@navarch/contracts";
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
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv });

function repo(): string {
  const dir = makeRepo();
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "auth.ts"), ["export function login(user: string) {", "  if (!user) throw new Error('missing user');", "  return createSession(user);", "}"].join("\n"));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "add auth");
  return dir;
}

async function start() {
  const home = tempHome();
  const claude = fakeClaude("specs");
  const daemon = new Daemon({ home, config: Config.parse({ daemon: { port: 0 }, routing: { enabled: false } }), adapters: { "claude-code": claude.options } });
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
  const wait = async (id: string): Promise<RunDetail> => {
    const end = Date.now() + 15_000;
    for (;;) {
      const r = (await api<RunDetail>("GET", `/api/v1/runs/${id}`)).body;
      if (r.status === "done" || r.status === "failed") return r;
      if (Date.now() > end) throw new Error(`timed out in ${r.status}`);
      await new Promise((res) => setTimeout(res, 50));
    }
  };
  return { api, wait, claude };
}

describe("reverse-spec Flow (ADR 0045)", () => {
  it("sends unusable drafts back, checks the evidence, and commits the verified specs on the run's branch", async () => {
    const { api, wait, claude } = await start();
    const dir = repo();
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: dir, prompt: "document src/auth.ts", flow: "reverse-spec" });
    expect(created.status).toBe(201);
    const run = await wait(created.body.id);
    expect(run.status).toBe("done");

    // The writer ran twice: the second time it was told what was wrong with the first answer.
    const prompts = claude.calls().map((c) => c.prompt);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("not valid JSON");

    const events = (await api<NavarchEvent[]>("GET", `/api/v1/runs/${created.body.id}/events`)).body;
    const generated = events.find((e) => e.type === "spec.generated")!.payload as { components: number; claims: number; confirmed: number; inferred: number; gap: number; downgraded: number; green_rate: number; branch: string; files: string[] };
    expect(generated).toMatchObject({ components: 1, claims: 3, confirmed: 1, inferred: 1, gap: 1, downgraded: 1, green_rate: 0.333 });
    expect(generated.files).toEqual([".navarch/specs/auth.md", ".navarch/specs/index.md", ".navarch/specs/index.json"]);

    // Committed on the run's branch, nothing touched in the user's clone.
    const show = (file: string) => git(dir, "show", `${generated.branch}:${file}`);
    expect(show(".navarch/specs/auth.md")).toContain("- 🟢 **rejects-empty** login throws when no user is given — `src/auth.ts:2`");
    expect(show(".navarch/specs/auth.md")).toContain("- 🟡 **uses-bcrypt**");
    expect(show(".navarch/specs/auth.md")).toContain("lowered: the cited file, line or quote was not found in the code");
    expect(JSON.parse(show(".navarch/specs/index.json")).coverage.green_rate).toBe(0.333);
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "log", "-1", "--format=%s", generated.branch)).toContain("docs(specs): verified specs for auth");

    const listed = (await api<SpecRunView[]>("GET", "/api/v1/specs")).body;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ run_id: created.body.id, run_name: created.body.name, components: 1, claims: 3, confirmed: 1, green_rate: 0.333, branch: generated.branch });
  });
});
