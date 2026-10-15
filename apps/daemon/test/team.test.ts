import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NavarchEvent, RunDetail, RunMessage, RunView } from "@navarch/contracts";
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

/** A repository at autonomy 3 whose check passes once codex.txt exists. */
function repo(): string {
  const dir = makeRepo();
  mkdirSync(join(dir, ".navarch"));
  writeFileSync(join(dir, ".navarch", "project.yaml"), "autonomy_level: 3\nverify:\n  - name: codex file\n    run: test -f codex.txt\n");
  execFileSync("git", ["add", "."], { cwd: dir, env: gitEnv });
  execFileSync("git", ["commit", "-q", "-m", "cfg"], { cwd: dir, env: gitEnv });
  return dir;
}

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
    expect(detail.tasks.map((t) => `${t.node_id}#${t.iteration}`)).toEqual(["team.lead#1", "team.api#1", "team.verify#1", "team.lead#2", "team.verify#2", "review#1"]);
    expect(byNode("team.lead")).toMatchObject({ profile: "lead", adapter: "claude-code" });
    expect(byNode("team.api")).toMatchObject({ profile: "implementer", adapter: "codex", status: "succeeded" });

    const routed = (daemon.store.events({ runId: run.id }) as NavarchEvent[]).filter((e) => e.type === "model.routed") as NavarchEvent<"model.routed">[];
    expect(routed.find((e) => e.task_id === byNode("team.api").id)?.payload.reason).toContain("preferred by the lead (codex)");

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
});
