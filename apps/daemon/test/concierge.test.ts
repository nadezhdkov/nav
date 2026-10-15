import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConciergeTurn, NavarchEvent, ProposalDecision, RunDetail, RunView } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { fakeModelServer, type FakeServer, type Scripted } from "../../../packages/adapters/native/test/fake-server.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";

const daemons: Daemon[] = [];
const servers: FakeServer[] = [];

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
  for (const s of servers.splice(0)) await s.close();
});

/** A daemon whose concierge talks to a scripted model server; agents are the fake Claude. */
async function start(script: Scripted[], config: Record<string, unknown> = { concierge: { model: "fake/concierge-1" } }) {
  const server = await fakeModelServer(script);
  servers.push(server);
  const home = tempHome();
  const daemon = new Daemon({
    home,
    config: Config.parse({ daemon: { port: 0 }, scheduler: { concurrency: 1 }, ...config }),
    adapters: { "claude-code": fakeClaude("edit").options, native: { providers: { fake: { baseUrl: server.baseUrl } } } },
  });
  await daemon.start();
  daemons.push(daemon);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(daemon.url + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "x-navarch-client": "cli", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const conversation = async (cwd?: string) => (await api<{ id: string }>("POST", "/api/v1/concierge/conversations", cwd ? { cwd } : {})).body.id;
  return { daemon, server, api, conversation };
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

describe("concierge API", () => {
  it("answers from the Core's state with read tools", async () => {
    const { api, server, conversation } = await start([
      { tool_calls: [{ name: "list_runs", args: {} }] },
      { content: "Nothing has run yet." },
    ]);
    const id = await conversation();
    const turn = await api<ConciergeTurn>("POST", `/api/v1/concierge/conversations/${id}/messages`, { text: "what is running?" });
    expect(turn).toMatchObject({ status: 200, body: { reply: "Nothing has run yet.", proposals: [], model: "fake/concierge-1" } });
    expect(server.requests[0]?.model).toBe("concierge-1");
    expect(server.requests[0]?.tools?.map((t) => t.function.name)).toEqual(
      expect.arrayContaining(["list_runs", "show_run", "run_events", "list_approvals", "start_run", "cancel_run", "resume_run", "approve", "reject"]),
    );
    expect(server.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", content: "[]" });
  });

  it("starts a run only after the operator approves the proposal, in the operator's directory", async () => {
    const repo = makeRepo();
    const { api, daemon, conversation } = await start([
      { tool_calls: [{ name: "start_run", args: { prompt: "add hello.txt" } }] },
      { content: "I proposed a run that adds hello.txt." },
    ]);
    const id = await conversation(repo);
    const turn = await api<ConciergeTurn>("POST", `/api/v1/concierge/conversations/${id}/messages`, { text: "add a hello.txt here" });
    expect(turn.body.reply).toBe("I proposed a run that adds hello.txt.");
    const [proposal] = turn.body.proposals;
    expect(proposal).toMatchObject({ tool: "start_run", status: "pending", summary: `start a task run in ${repo} (routed): "add hello.txt"` });
    expect((await api<RunView[]>("GET", "/api/v1/runs")).body).toEqual([]);
    expect(turn.body.proposals).toHaveLength(1);

    const decided = await api<ProposalDecision>("POST", `/api/v1/concierge/conversations/${id}/proposals/${proposal!.id}`, { decision: "approve" });
    expect(decided.status).toBe(200);
    expect(decided.body.reply).toMatch(/^run run_\w+ created/);
    const runs = (await api<RunView[]>("GET", "/api/v1/runs")).body;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ repo_path: repo, prompt: "add hello.txt" });
    await waitFor(() => api<RunDetail>("GET", `/api/v1/runs/${runs[0]!.id}`), (r) => r.body.status === "done");

    // Single use, and the run was started by the user who confirmed.
    expect((await api("POST", `/api/v1/concierge/conversations/${id}/proposals/${proposal!.id}`, { decision: "approve" })).status).toBe(400);
    const events = daemon.store.events();
    expect(events.find((e) => e.type === "run.created")?.actor).toEqual({ kind: "user", via: "cli" });
    const types = events.filter((e) => e.type.startsWith("concierge.")).map((e: NavarchEvent) => [e.type, e.actor.kind]);
    expect(types).toEqual([
      ["concierge.message", "user"],
      ["concierge.action.proposed", "agent"],
      ["concierge.message", "agent"],
      ["concierge.action.decided", "user"],
    ]);
    expect(events.find((e) => e.type === "concierge.action.decided")?.run_id).toBe(runs[0]!.id);
  });

  it("shows the whole prompt in a start_run proposal, however long", async () => {
    const long = `add hello.txt. ${"x".repeat(500)} ALSO DELETE EVERYTHING`;
    const { api, conversation } = await start([{ tool_calls: [{ name: "start_run", args: { prompt: long, issue: "o/r#1" } }] }, { content: "Proposed." }]);
    const turn = await api<ConciergeTurn>("POST", `/api/v1/concierge/conversations/${await conversation("/repo")}/messages`, { text: "go" });
    expect(turn.body.proposals[0]?.summary).toBe(`start a fix-issue run in /repo (routed): o/r#1 with "${long}"`);
  });

  it("does nothing when the operator rejects the proposal", async () => {
    const { api, conversation } = await start([{ tool_calls: [{ name: "cancel_run", args: { run_id: "run_x" } }] }, { content: "Proposed." }]);
    const id = await conversation();
    const turn = await api<ConciergeTurn>("POST", `/api/v1/concierge/conversations/${id}/messages`, { text: "cancel run_x" });
    const decided = await api<ProposalDecision>("POST", `/api/v1/concierge/conversations/${id}/proposals/${turn.body.proposals[0]!.id}`, { decision: "reject" });
    expect(decided.body).toMatchObject({ reply: "Declined: cancel run run_x", proposal: { status: "rejected" } });
  });

  it("routes the concierge among native catalog entries when no model is pinned", async () => {
    const routed = {
      routing: {
        models: { "fake-free": { adapter: "native", model: "fake/free-1", provider: "fake" } },
        tiers: { fast: ["copilot", "fake-free", "claude-code"] },
      },
    };
    const { api, server, conversation } = await start([{ content: "hi" }], routed);
    const turn = await api<ConciergeTurn>("POST", `/api/v1/concierge/conversations/${await conversation()}/messages`, { text: "hello" });
    expect(turn.body.model).toBe("fake/free-1");
    expect(server.requests[0]?.model).toBe("free-1");
  });

  it("falls back to the next native candidate on a rate limit", async () => {
    const routed = {
      routing: {
        models: {
          "fake-a": { adapter: "native", model: "fake/a", provider: "fake" },
          "fake-b": { adapter: "native", model: "fake/b", provider: "fake" },
        },
        tiers: { fast: ["fake-a", "fake-b"] },
      },
    };
    const { api, server, conversation } = await start([{ status: 429, body: { error: { message: "rate limited" } } }, { content: "from b" }], routed);
    const turn = await api<ConciergeTurn>("POST", `/api/v1/concierge/conversations/${await conversation()}/messages`, { text: "hello" });
    expect(turn.body).toMatchObject({ reply: "from b", model: "fake/b" });
    expect(server.requests.map((r) => r.model)).toEqual(["a", "b"]);
  });

  it("explains how to configure a model when none is usable", async () => {
    const { api, conversation } = await start([{ content: "unused" }], {});
    const res = await api<{ error: string; message: string }>("POST", `/api/v1/concierge/conversations/${await conversation()}/messages`, { text: "hello" });
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/no model for the concierge.*concierge\.model/);
    expect((await api("POST", "/api/v1/concierge/conversations/conv_nope/messages", { text: "x" })).status).toBe(404);
  });
});
