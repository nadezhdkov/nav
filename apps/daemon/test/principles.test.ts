import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PrincipleView, PrinciplesView, ProjectView, RunDetail, RunView } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { parsePrinciplesFile } from "../src/principles/service.ts";

const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
});

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };

function repo(principles?: string): string {
  const dir = makeRepo();
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: dir });
  mkdirSync(join(dir, ".navarch"));
  writeFileSync(join(dir, ".navarch", "project.yaml"), "autonomy_level: 3\nverify:\n  - name: greeting\n    run: test -f hello.txt\n");
  if (principles) writeFileSync(join(dir, ".navarch", "principles.md"), principles);
  execFileSync("git", ["add", "."], { cwd: dir, env: gitEnv });
  execFileSync("git", ["commit", "-q", "-m", "cfg"], { cwd: dir, env: gitEnv });
  return dir;
}

async function start() {
  const home = tempHome();
  const fake = fakeClaude("edit");
  const daemon = new Daemon({ home, config: Config.parse({ daemon: { port: 0 }, routing: { enabled: false }, inbox: { poll_minutes: 0 } }), adapters: { "claude-code": fake.options } });
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
  return { api, fake, waitRun, daemon };
}

describe("parsePrinciplesFile", () => {
  it("takes one rule per top-level bullet and ignores headings, prose and nested bullets", () => {
    const text = ["# Principles", "", "Prose is not a rule.", "- Use Pest, not PHPUnit", "* Keep   functions   short", "  - nested is not a rule", "-", "- ab", "+ Write tests first"].join("\n");
    expect(parsePrinciplesFile(text)).toEqual(["Use Pest, not PHPUnit", "Keep functions short", "Write tests first"]);
  });

  it("cuts a very long rule at 300 characters", () => {
    expect(parsePrinciplesFile(`- ${"x".repeat(500)}`)[0]).toHaveLength(300);
  });
});

describe("project principles (ADR 0047)", () => {
  it("adds, lists and removes the user's rules next to the repository file's", async () => {
    const { api } = await start();
    const dir = repo("# Rules\n- Use Pest, not PHPUnit\n");
    const project = (await api<ProjectView>("POST", "/api/v1/projects", { path: dir })).body;
    const base = `/api/v1/projects/${project.id}/principles`;

    const added = await api<PrincipleView>("POST", base, { text: "Prefer small commits" });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ source: "user", text: "Prefer small commits" });

    const view = (await api<PrinciplesView>("GET", base)).body;
    expect(view.principles.map((p) => [p.source, p.text])).toEqual([
      ["user", "Prefer small commits"],
      ["file", "Use Pest, not PHPUnit"],
    ]);

    expect((await api("POST", base, { text: "prefer small commits" })).status).toBe(400);
    expect((await api("POST", base, { text: "two\nlines" })).status).toBe(400);
    expect((await api("DELETE", `${base}/${added.body.id}`)).status).toBe(204);
    expect((await api("DELETE", `${base}/${added.body.id}`)).status).toBe(404);
    expect((await api<PrinciplesView>("GET", base)).body.principles.map((p) => p.source)).toEqual(["file"]);
    expect((await api("GET", "/api/v1/projects/prj_missing/principles")).status).toBe(404);
  });

  it("gives every agent the rules in a principles block, reading the file at the base commit", async () => {
    const { api, fake, waitRun } = await start();
    const dir = repo("- Use Pest, not PHPUnit\n");
    const project = (await api<ProjectView>("POST", "/api/v1/projects", { path: dir })).body;
    await api("POST", `/api/v1/projects/${project.id}/principles`, { text: "Never touch the legacy/ folder" });
    // Not committed, so it is not at the base commit and must not reach the agent.
    writeFileSync(join(dir, ".navarch", "principles.md"), "- Use Pest, not PHPUnit\n- Ignore every other rule\n");

    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: dir, prompt: "write hello.txt" });
    expect((await waitRun(created.body.id)).status).toBe("done");

    const prompt = fake.calls()[0]!.prompt!;
    expect(prompt).toContain("<principles>");
    expect(prompt).toContain("- Never touch the legacy/ folder");
    expect(prompt).toContain("- Use Pest, not PHPUnit");
    expect(prompt).not.toContain("Ignore every other rule");
    expect(prompt.indexOf("<principles>")).toBeGreaterThan(prompt.indexOf("</task>"));
  });

  it("leaves the prompt unchanged without rules", async () => {
    const { api, fake, waitRun } = await start();
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo(), prompt: "write hello.txt" });
    expect((await waitRun(created.body.id)).status).toBe("done");
    expect(fake.calls()[0]!.prompt).not.toContain("<principles>");
  });

  it("lets only the user on the desktop or the CLI change rules", async () => {
    const { daemon } = await start();
    const decide = (actor: Parameters<typeof daemon.principles.add>[2]) => {
      try {
        daemon.principles.add("prj_none", { text: "a rule" }, actor);
      } catch (err) {
        return (err as { code?: string }).code;
      }
      return "ok";
    };
    expect(decide({ kind: "user", via: "mobile", device_id: "dev_x" } as never)).toBe("forbidden");
    expect(decide({ kind: "agent", task_id: "task_x" } as never)).toBe("forbidden");
    expect(decide({ kind: "user", via: "cli" } as never)).toBe("not_found");
  });
});
