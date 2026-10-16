import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FleetView, NavarchEvent, RunDetail, RunMessage, RunView } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude, type FakeScenario } from "../../../packages/adapters/claude-code/test/fake.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";

const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
});

const fakeCodex = fileURLToPath(new URL("../../../packages/adapters/codex/test/fixtures/fake-codex.mjs", import.meta.url));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };

/** A repository at autonomy 3 whose check passes once codex.txt exists (or the given check). */
function repo(check = "test -f codex.txt"): string {
  const dir = makeRepo();
  mkdirSync(join(dir, ".navarch"));
  writeFileSync(join(dir, ".navarch", "project.yaml"), `autonomy_level: 3\nverify:\n  - name: team files\n    run: ${check}\n`);
  execFileSync("git", ["add", "."], { cwd: dir, env: gitEnv });
  execFileSync("git", ["commit", "-q", "-m", "cfg"], { cwd: dir, env: gitEnv });
  return dir;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

async function start(scenario: FakeScenario) {
  const home = tempHome();
  const claude = fakeClaude(scenario);
  const codexState = mkdtempSync(join(tmpdir(), "navarch-fake-codex-"));
  const config = Config.parse({
    daemon: { port: 0 },
    routing: { tiers: { fast: ["claude-code"], standard: ["claude-code"], expert: ["claude-code"] } },
  });
  const daemon = new Daemon({
    home,
    config,
    adapters: { "claude-code": claude.options, codex: { command: process.execPath, commandArgs: [fakeCodex, "edit", codexState] } },
  });
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
  return { daemon, api, claude };
}

async function waitFor<T>(fn: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const end = Date.now() + 12_000;
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("team runs (ADR 0022)", () => {
  it("a lead delegates to a member on its preferred agent, reads the result and finishes", async () => {
    const { api, daemon, claude } = await start("lead");
    const run = (await api<RunView>("POST", "/api/v1/runs", { repo_path: repo(), prompt: "add codex.txt", flow: "team" })).body;
    const detail = (await waitFor(() => api<RunDetail>("GET", `/api/v1/runs/${run.id}`), (r) => ["done", "failed"].includes(r.body.status))).body;
    expect(detail.status, JSON.stringify(detail.tasks.map((t) => [t.node_id, t.status, t.error]))).toBe("done");

    const byNode = (id: string, iteration = 1) => detail.tasks.find((t) => t.node_id === id && t.iteration === iteration)!;
    expect(detail.tasks.map((t) => `${t.node_id}#${t.iteration}`)).toEqual(["team.lead#1", "team.api#1", "team.api.integrate#1", "team.verify#1", "team.lead#2", "team.verify#2", "review#1"]);
    expect(byNode("team.lead")).toMatchObject({ profile: "lead", adapter: "claude-code" });
    expect(byNode("team.api")).toMatchObject({ profile: "implementer", adapter: "codex", status: "succeeded" });

    const routed = (daemon.store.events({ runId: run.id }) as NavarchEvent[]).filter((e) => e.type === "model.routed") as NavarchEvent<"model.routed">[];
    expect(routed.find((e) => e.task_id === byNode("team.api").id)?.payload.reason).toContain("preferred by the lead (codex)");

    expect(detail.team).toMatchObject({
      node_id: "team",
      turn: 2,
      max_turns: 8,
      lead_task_id: byNode("team.lead", 2).id,
      question: null,
      summary: "Team finished: codex.txt added by the api member.",
      plan_errors: [],
      members: [{ key: "api", profile: "implementer", prefer: "codex", turn: 1, task_id: byNode("team.api").id, status: "succeeded", summary: "Added codex.txt.", merge: "merged" }],
      subagents: [{ task_id: byNode("team.lead").id, tool_use_id: "toolu_lead1", description: "Survey the repository", status: "finished" }],
    });

    // The lead's own sub-agent is observed on its first turn.
    const subagents = (daemon.store.events({ runId: run.id }) as NavarchEvent[]).filter((e) => e.type === "task.subagent") as NavarchEvent<"task.subagent">[];
    expect(subagents.map((e) => [e.task_id, e.payload.description, e.payload.status])).toEqual([
      [byNode("team.lead").id, "Survey the repository", "started"],
      [byNode("team.lead").id, "Survey the repository", "finished"],
    ]);

    // The second turn resumed the lead's session with only the update, which names the member's result.
    const calls = claude.calls();
    const lead2 = calls.find((c) => c.prompt.includes("This is your next turn as the team lead"))!;
    expect(lead2.args).toContain("--resume");
    expect(lead2.prompt).toContain('<input name="team">');
    expect(lead2.prompt).toContain("Added codex.txt.");
    expect(lead2.prompt).not.toContain("You are the Navarch lead agent");
    const lead1 = calls.find((c) => c.prompt.includes("You are the Navarch lead agent"))!;
    expect(lead1.prompt).toMatch(/codex \(codex\): available/);
    // The member got the brief, not the lead's conversation.
    const review = calls.find((c) => c.prompt.includes("You are the Navarch reviewer agent"))!;
    expect(review.prompt).toContain("Team finished: codex.txt added by the api member.");
  });

  it("an answer from the user unblocks a lead that asked a question", async () => {
    const { api, claude } = await start("lead-question");
    const run = (await api<RunView>("POST", "/api/v1/runs", { repo_path: repo(), prompt: "add a file", flow: "team" })).body;
    const blocked = await waitFor(
      () => api<RunDetail>("GET", `/api/v1/runs/${run.id}`),
      (r) => r.body.tasks.some((t) => t.node_id === "team.lead" && t.iteration === 2 && t.status === "blocked"),
    );
    expect(blocked.body.status).not.toBe("failed");
    expect(blocked.body.team).toMatchObject({ turn: 2, question: "Which file name?" });
    const fleet = await api<FleetView>("GET", "/api/v1/fleet");
    const lead = fleet.body.runs.find((r) => r.id === run.id)!.agents.find((a) => a.team_role === "lead")!;
    expect(lead).toMatchObject({ status: "blocked", waiting: { kind: "question" }, iteration: 2 });

    const sent = await api<RunMessage>("POST", `/api/v1/runs/${run.id}/messages`, { text: "Call it codex.txt." });
    expect(sent.status).toBe(201);
    const detail = (await waitFor(() => api<RunDetail>("GET", `/api/v1/runs/${run.id}`), (r) => ["done", "failed"].includes(r.body.status))).body;
    expect(detail.status, JSON.stringify(detail.tasks.map((t) => [t.node_id, t.iteration, t.status, t.error]))).toBe("done");
    const [message] = (await api<RunMessage[]>("GET", `/api/v1/runs/${run.id}/messages`)).body;
    // Every turn after the first resumed the same session, also after a resumed turn.
    const leadCalls = claude.calls().filter((c) => !c.prompt.includes("You are the Navarch reviewer agent"));
    expect(leadCalls.length).toBeGreaterThanOrEqual(3);
    expect(leadCalls.slice(1).every((c) => c.args.includes("--resume"))).toBe(true);
    expect(message!.delivered).toMatchObject({ task_id: detail.tasks.find((t) => t.node_id === "team.lead" && t.iteration === 2)!.id });
  });

  it("runs independent members at once in their own worktrees and merges both back (ADR 0029)", async () => {
    const { api, claude } = await start("lead-parallel");
    const run = (await api<RunView>("POST", "/api/v1/runs", { repo_path: repo("test -f a.txt && test -f b.txt"), prompt: "add a.txt and b.txt", flow: "team" })).body;
    const detail = (await waitFor(() => api<RunDetail>("GET", `/api/v1/runs/${run.id}`), (r) => ["done", "failed"].includes(r.body.status))).body;
    expect(detail.status, JSON.stringify(detail.tasks.map((t) => [t.node_id, t.status, t.error]))).toBe("done");

    // Both members ran at the same time.
    expect(existsSync(join(claude.stateDir, "overlapped-a")) || existsSync(join(claude.stateDir, "overlapped-b"))).toBe(true);
    const cwd = (key: string) => claude.calls().find((c) => c.prompt.includes(`Create ${key}.txt`))!.cwd;
    expect(cwd("a")).toMatch(new RegExp(`${run.id}-team-a$`));
    expect(cwd("b")).toMatch(new RegExp(`${run.id}-team-b$`));
    expect(detail.team!.members.map((m) => [m.key, m.status, m.merge, m.branch])).toEqual([
      ["a", "succeeded", "merged", `navarch/${run.id}/team-a`],
      ["b", "succeeded", "merged", `navarch/${run.id}/team-b`],
    ]);

    // The run's own branch carries both members' work; verification ran there.
    const lead = detail.tasks.find((t) => t.node_id === "team.lead")!;
    const shared = (await api<{ path: string; branch: string; files: { path: string }[] }>("GET", `/api/v1/runs/${run.id}/worktree`)).body;
    expect(shared.branch).toBe(`navarch/${run.id}/team`);
    expect(shared.files.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
    expect(git(shared.path, "log", "--format=%s")).toMatch(/Merge team member b[\s\S]*Merge team member a|Merge team member a[\s\S]*Merge team member b/);
    expect(detail.tasks.find((t) => t.node_id === "team.verify")).toMatchObject({ status: "succeeded" });
    expect(lead.status).toBe("succeeded");

    // A member's own worktree, by task.
    const member = detail.tasks.find((t) => t.node_id === "team.a")!;
    const own = (await api<{ branch: string; files: { path: string }[] }>("GET", `/api/v1/runs/${run.id}/worktree?task=${member.id}`)).body;
    expect(own.branch).toBe(`navarch/${run.id}/team-a`);
    expect(own.files.map((f) => f.path)).toEqual(["a.txt"]);
  });

  it("sends a merge conflict to an implementer and concludes the merge (ADR 0029)", async () => {
    const { api } = await start("lead-conflict");
    const run = (await api<RunView>("POST", "/api/v1/runs", { repo_path: repo('grep -q "from a and b" shared.txt'), prompt: "write shared.txt", flow: "team" })).body;
    const detail = (await waitFor(() => api<RunDetail>("GET", `/api/v1/runs/${run.id}`), (r) => ["done", "failed"].includes(r.body.status))).body;
    expect(detail.status, JSON.stringify(detail.tasks.map((t) => [t.node_id, t.iteration, t.status, t.error]))).toBe("done");
    const ids = detail.tasks.map((t) => `${t.node_id}#${t.iteration}`);
    const second = ids.includes("team.b.resolve#1") ? "b" : "a";
    expect(ids).toEqual(expect.arrayContaining([`team.${second}.integrate#1`, `team.${second}.resolve#1`, `team.${second}.integrate#2`]));
    expect(detail.tasks.find((t) => t.node_id === `team.${second}.resolve`)).toMatchObject({ profile: "implementer", status: "succeeded" });
    expect(detail.team!.members.every((m) => m.merge === "merged")).toBe(true);
    const shared = (await api<{ path: string }>("GET", `/api/v1/runs/${run.id}/worktree`)).body;
    expect(readFileSync(join(shared.path, "shared.txt"), "utf8")).toBe("from a and b\n");
    expect(git(shared.path, "status", "--porcelain")).toBe("");
  });
});
