import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
      expect.arrayContaining(["list_runs", "show_run", "run_events", "list_inbox", "show_usage", "list_approvals", "start_run", "cancel_run", "send_instruction", "resume_run", "approve", "reject"]),
    );
    expect(server.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", content: "[]" });
  });

  it("reads budgets and spend with show_usage, and cannot change them (ADR 0023)", async () => {
    const { api, server, conversation } = await start([{ tool_calls: [{ name: "show_usage", args: {} }] }, { content: "Nothing spent." }]);
    const id = await conversation();
    await api<ConciergeTurn>("POST", `/api/v1/concierge/conversations/${id}/messages`, { text: "how much did I spend?" });
    const result = JSON.parse(String(server.requests[1]?.messages.at(-1)?.content)) as { today: { cost: number }; budgets: { scope: string; limit: number | null }[] };
    expect(result.today.cost).toBe(0);
    expect(result.budgets[0]).toMatchObject({ scope: "global_monthly", limit: 100 });
    expect(server.requests[0]?.tools?.map((t) => t.function.name).some((n) => n.includes("budget"))).toBe(false);
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

  it("proposes a compete run with its budget and number of competitors (ADR 0031)", async () => {
    const repo = makeRepo();
    const { api, conversation } = await start([
      { tool_calls: [{ name: "start_run", args: { prompt: "add hello.txt", flow: "compete", budget: 3, competitors: 2 } }] },
      { content: "Proposed." },
    ]);
    const id = await conversation(repo);
    const turn = await api<ConciergeTurn>("POST", `/api/v1/concierge/conversations/${id}/messages`, { text: "two agents should compete on hello.txt, $3 at most" });
    const [proposal] = turn.body.proposals;
    expect(proposal!.summary).toBe(`start a compete run in ${repo} (routed), 2 competitors, budget $3: "add hello.txt"`);
    await api("POST", `/api/v1/concierge/conversations/${id}/proposals/${proposal!.id}`, { decision: "approve" });
    const [run] = (await api<RunDetail[]>("GET", "/api/v1/runs")).body;
    expect(run).toMatchObject({ flow: "compete", budget: 3 });
    const detail = (await api<RunDetail>("GET", `/api/v1/runs/${run!.id}`)).body;
    expect(detail.flow_definition?.params).toMatchObject({ competitors: 2 });
  });

  it("attaches files from the repository to a run it starts, and nothing outside it (ADR 0028)", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "docs", "spec.md"), "# Spec\nhello.txt says hi\n");
    const outside = join(tempHome(), "secret.txt");
    writeFileSync(outside, "do not send");
    const { api, conversation } = await start([
      { tool_calls: [{ name: "start_run", args: { prompt: "follow the spec", attach: ["docs/spec.md"] } }] },
      { content: "Proposed." },
      { tool_calls: [{ name: "start_run", args: { prompt: "read it", attach: [outside] } }] },
      { content: "Proposed." },
    ]);
    const id = await conversation(repo);
    const turn = await api<ConciergeTurn>("POST", `/api/v1/concierge/conversations/${id}/messages`, { text: "start it with the spec" });
    const proposal = turn.body.proposals[0]!;
    expect(proposal.summary).toBe(`start a task run in ${repo} (routed): "follow the spec", attaching docs/spec.md`);
    const decided = await api<ProposalDecision>("POST", `/api/v1/concierge/conversations/${id}/proposals/${proposal.id}`, { decision: "approve" });
    expect(decided.body.reply).toMatch(/^run run_\w+ created/);
    const [run] = (await api<RunView[]>("GET", "/api/v1/runs")).body;
    expect((await api<RunDetail>("GET", `/api/v1/runs/${run!.id}`)).body.attachments).toEqual([{ name: "spec.md", bytes: 25 }]);

    const second = await api<ConciergeTurn>("POST", `/api/v1/concierge/conversations/${id}/messages`, { text: "and attach that file" });
    const refused = await api<ProposalDecision>("POST", `/api/v1/concierge/conversations/${id}/proposals/${second.body.proposals[0]!.id}`, { decision: "approve" });
    expect(JSON.stringify(refused.body)).toMatch(/outside the repository/);
    expect((await api<RunView[]>("GET", "/api/v1/runs")).body).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("refuses to attach a named pipe instead of blocking on it (ADR 0028)", async () => {
    const repo = makeRepo();
    execFileSync("mkfifo", [join(repo, "pipe")]);
    const { api, conversation } = await start([
      { tool_calls: [{ name: "start_run", args: { prompt: "read it", attach: ["pipe"] } }] },
      { content: "Proposed." },
    ]);
    const id = await conversation(repo);
    const turn = await api<ConciergeTurn>("POST", `/api/v1/concierge/conversations/${id}/messages`, { text: "attach the pipe" });
    const refused = await api<ProposalDecision>("POST", `/api/v1/concierge/conversations/${id}/proposals/${turn.body.proposals[0]!.id}`, { decision: "approve" });
    expect(JSON.stringify(refused.body)).toMatch(/not a file/);
    expect((await api<RunView[]>("GET", "/api/v1/runs")).body).toHaveLength(0);
  });

  it("shows the whole prompt in a start_run proposal, however long", async () => {
    const long = `add hello.txt. ${"x".repeat(500)} ALSO DELETE EVERYTHING`;
    const { api, conversation } = await start([{ tool_calls: [{ name: "start_run", args: { prompt: long, issue: "o/r#1" } }] }, { content: "Proposed." }]);
    const turn = await api<ConciergeTurn>("POST", `/api/v1/concierge/conversations/${await conversation("/repo")}/messages`, { text: "go" });
    expect(turn.body.proposals[0]?.summary).toBe(`start a fix-issue run in /repo (routed): o/r#1 with "${long}"`);
  });

  it("sends an instruction to a run once the operator confirms", async () => {
    const call = { name: "send_instruction", args: { run_id: "", text: "use pnpm, not npm" } };
    const { api, daemon, conversation } = await start([{ tool_calls: [call] }, { content: "Proposed." }, { content: "Sent." }], {
      concierge: { model: "fake/concierge-1" },
      autonomy_level: 0,
    });
    // Autonomy 0 holds the run at its first approval, so it is still open for instructions.
    const run = (await api<RunView>("POST", "/api/v1/runs", { repo_path: makeRepo(), prompt: "add hello" })).body;
    call.args.run_id = run.id;
    const id = await conversation();
    const turn = await api<ConciergeTurn>("POST", `/api/v1/concierge/conversations/${id}/messages`, { text: "tell it to use pnpm" });
    const proposal = turn.body.proposals[0]!;
    expect(proposal.summary).toBe(`tell run ${run.id} in its next turn: use pnpm, not npm`);
    expect(daemon.store.listMessages(run.id)).toEqual([]);

    const decided = await api<ProposalDecision>("POST", `/api/v1/concierge/conversations/${id}/proposals/${proposal.id}`, { decision: "approve" });
    expect(decided.body.proposal.status).toBe("approved");
    expect(daemon.store.listMessages(run.id)).toMatchObject([{ text: "use pnpm, not npm", delivery: "next", task_id: null }]);
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
