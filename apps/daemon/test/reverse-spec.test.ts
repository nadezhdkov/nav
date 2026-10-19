import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalView, NavarchEvent, RunDetail, RunView, SpecRunView } from "@navarch/contracts";
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
  /** The pending approval of a node of this run, once it is there. */
  const approval = async (runId: string, node: string): Promise<ApprovalView> => {
    const end = Date.now() + 15_000;
    for (;;) {
      const found = (await api<ApprovalView[]>("GET", "/api/v1/approvals")).body.find((a) => a.run_id === runId && a.task_id && a.summary.includes(node));
      if (found) return found;
      if (Date.now() > end) throw new Error(`no approval for ${node}`);
      await new Promise((res) => setTimeout(res, 50));
    }
  };
  return { api, wait, claude, approval };
}

describe("reverse-spec Flow (ADR 0045)", () => {
  it("sends unusable drafts back, checks the evidence, and commits the verified specs on the run's branch", async () => {
    const { api, wait, claude } = await start();
    const dir = repo();
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: dir, prompt: "document src/auth.ts", flow: "reverse-spec", params: { open_pr: false } });
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

  it("interviews first: a scout asks, the run waits for the answers, and the writer gets them", async () => {
    const { api, wait, claude, approval } = await start();
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo(), prompt: "document src/auth.ts", flow: "reverse-spec", params: { open_pr: false, interview: true } });
    expect(created.status).toBe(201);
    const scope = await approval(created.body.id, "approve_scope");
    expect(scope.summary).toContain("Should login lock the account");
    // Only the scout has run; the writer waits for the user.
    expect(claude.calls()).toHaveLength(1);
    expect(claude.calls()[0]!.prompt).toContain("Navarch spec-scout agent");

    await api("POST", `/api/v1/runs/${created.body.id}/messages`, { text: "Yes, lock after 5 failures.", delivery: "next" });
    expect((await api("POST", `/api/v1/approvals/${scope.id}`, { decision: "approve" })).status).toBe(200);
    const run = await wait(created.body.id);
    expect(run.status).toBe("done");

    const writer = claude.calls().filter((c) => c.prompt.includes("Navarch spec-writer agent"));
    expect(writer[0]!.prompt).toContain('<input name="scope">');
    expect(writer[0]!.prompt).toContain("Should login lock the account");
    expect(writer[0]!.prompt).toContain("Yes, lock after 5 failures.");
  });

  it("waits for a review of the written specs before the PR when review is on", async () => {
    const { api, wait, approval } = await start();
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo(), prompt: "document src/auth.ts", flow: "reverse-spec", params: { open_pr: false, review: true } });
    const review = await approval(created.body.id, "approve_specs");
    expect(review.summary).toContain("component(s)");
    // The specs are written and committed before the pause; nothing was asked up front.
    const events = (await api<NavarchEvent[]>("GET", `/api/v1/runs/${created.body.id}/events`)).body;
    expect(events.some((e) => e.type === "spec.generated")).toBe(true);
    expect(events.some((e) => e.type === "task.created" && (e.payload as { node_id: string }).node_id === "scout")).toBe(false);
    expect((await api("POST", `/api/v1/approvals/${review.id}`, { decision: "approve" })).status).toBe(200);
    expect((await wait(created.body.id)).status).toBe("done");
  });

  it("stops before the writer when the user rejects the scope", async () => {
    const { api, claude, approval } = await start();
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo(), prompt: "document src/auth.ts", flow: "reverse-spec", params: { open_pr: false, interview: true } });
    const scope = await approval(created.body.id, "approve_scope");
    await api("POST", `/api/v1/approvals/${scope.id}`, { decision: "reject", reason: "wrong scope" });
    const end = Date.now() + 15_000;
    while ((await api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`)).body.status !== "cancelled") {
      if (Date.now() > end) throw new Error("the run was not cancelled");
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(claude.calls().some((c) => c.prompt.includes("Navarch spec-writer agent"))).toBe(false);
  });

  it("asks nothing by default", async () => {
    const { api, wait, claude } = await start();
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo(), prompt: "document src/auth.ts", flow: "reverse-spec", params: { open_pr: false } });
    expect((await wait(created.body.id)).status).toBe("done");
    expect(claude.calls().some((c) => c.prompt.includes("Navarch spec-scout agent"))).toBe(false);
    expect((await api<ApprovalView[]>("GET", "/api/v1/approvals")).body.filter((a) => a.run_id === created.body.id)).toEqual([]);
  });
});
