import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRepo } from "../../../runner/test/helpers.ts";
import { collect, taskContext } from "../../kit/test/fake-cli.ts";
import { NativeAdapter, SandboxTools, splitCommand } from "../src/index.ts";
import { fakeModelServer, type FakeServer } from "./fake-server.ts";

const servers: FakeServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function setup(script: Parameters<typeof fakeModelServer>[0]) {
  const server = await fakeModelServer(script);
  servers.push(server);
  const repo = makeRepo();
  const adapter = new NativeAdapter({ providers: { fake: { baseUrl: server.baseUrl } } });
  const ctx = taskContext({ model: "fake/coder-1", sandbox: { id: "s", kind: "worktree", path: repo, branch: "b", baseCommit: "c" } });
  return { server, repo, adapter, ctx };
}

describe("NativeAdapter", () => {
  it("runs a tool loop: reads, edits, is denied a command, and finishes with a summary", async () => {
    const { server, repo, adapter, ctx } = await setup([
      { tool_calls: [{ name: "read_file", args: { path: "README.md" } }] },
      { tool_calls: [{ name: "edit_file", args: { path: "README.md", old_text: "# test repo", new_text: "# Test Repo\n\nDocs." } }] },
      { tool_calls: [{ name: "run_command", args: { command: "curl https://evil.example" } }] },
      { content: "Updated the README heading.", cost: 0.001 },
    ]);
    const { events, io } = collect();
    const result = await adapter.run(ctx, io);

    expect(result).toMatchObject({ status: "succeeded", summary: "Updated the README heading." });
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# Test Repo\n\nDocs.\n");
    expect(result.usage[0]).toMatchObject({ model: "fake/coder-1", tokens_in: 200, tokens_out: 40, cost: 0.001 });
    expect(events).toContainEqual({ kind: "denied", tool: "run_command", input: "run_command curl https://evil.example" });

    expect(server.requests[0]?.model).toBe("coder-1");
    expect(server.requests[0]?.tools?.map((t) => t.function.name)).toEqual(["list_files", "read_file", "search", "write_file", "edit_file", "run_command"]);
    const toolReply = server.requests[1]?.messages.at(-1);
    expect(toolReply).toMatchObject({ role: "tool" });
    expect(toolReply?.content).toContain("1\t# test repo");
  });

  it("maps HTTP errors to retry classes", async () => {
    const limited = await setup([{ status: 429, body: { error: { message: "free model rate limit" } } }]);
    expect(await limited.adapter.run(limited.ctx, collect().io)).toMatchObject({ status: "failed", error: { kind: "rate_limited" } });

    const waited = await setup([{ status: 429, headers: { "retry-after": "120" }, body: { error: { message: "rate limit" } } }]);
    const result = await waited.adapter.run(waited.ctx, collect().io);
    expect(result.error?.message).toContain("retry after 120s");
    expect(Date.parse(result.error!.retry_at!)).toBeGreaterThan(Date.now() + 100_000);
    const auth = await setup([{ status: 401, body: { error: { message: "no auth" } } }]);
    expect(await auth.adapter.run(auth.ctx, collect().io)).toMatchObject({ status: "failed", error: { kind: "fatal" } });
  });

  it("gives up on a model call that never answers, instead of hanging the task", async () => {
    const server = await fakeModelServer([{ hang: true }]);
    servers.push(server);
    const adapter = new NativeAdapter({ providers: { fake: { baseUrl: server.baseUrl } }, requestTimeoutMs: 300 });
    const ctx = taskContext({ model: "fake/coder-1", sandbox: { id: "s", kind: "worktree", path: makeRepo(), branch: "b", baseCommit: "c" } });
    const result = await adapter.run(ctx, collect().io);
    expect(result).toMatchObject({ status: "failed", error: { kind: "transient" } });
    expect(result.error?.message).toMatch(/no response .* within 0\.3s/);
  });

  it("reads a provider's key when the task starts, and reports a provider without one as unavailable", async () => {
    const server = await fakeModelServer([{ content: "done" }]);
    servers.push(server);
    let key: string | undefined;
    const adapter = new NativeAdapter({
      providers: {
        paid: { baseUrl: server.baseUrl, requiresKey: true, getApiKey: async () => key },
        local: { baseUrl: server.baseUrl },
      },
    });
    const ctx = taskContext({ model: "paid/coder-1", sandbox: { id: "s", kind: "worktree", path: makeRepo(), branch: "b", baseCommit: "c" } });
    expect(await adapter.run(ctx, collect().io)).toMatchObject({ status: "failed", error: { kind: "fatal", message: "no API key for provider paid" } });
    expect(server.requests).toHaveLength(0);
    expect(adapter.unavailableReason("paid/coder-1")).toBe("no API key for provider paid");
    expect(adapter.unavailableReason("local/coder-1")).toBeUndefined();
    expect(adapter.unavailableReason("other/coder-1")).toContain("provider one of: paid, local");

    key = "sk-test"; // stored later with `navarch secret set`: the next task picks it up
    expect(await adapter.run(ctx, collect().io)).toMatchObject({ status: "succeeded" });
    expect(adapter.unavailableReason("paid/coder-1")).toBeUndefined();
  });

  it("turns OpenRouter's free-model daily limit into a quota scoped to the provider's models", async () => {
    // 🟡 Shape of OpenRouter's documented 429 for `:free` models (reset in error.metadata.headers, epoch ms).
    const reset = Date.parse("2026-10-16T00:00:00.000Z");
    const { adapter, ctx } = await setup([
      {
        status: 429,
        body: {
          error: {
            code: 429,
            message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
            metadata: { headers: { "X-RateLimit-Limit": "50", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(reset) } },
          },
        },
      },
    ]);
    const { events, io } = collect();
    const result = await adapter.run(ctx, io);
    expect(result.error).toMatchObject({ kind: "rate_limited", retry_at: "2026-10-16T00:00:00.000Z" });
    expect(events).toContainEqual({ kind: "quota", window: "free-models-per-day", resetsAt: "2026-10-16T00:00:00.000Z", exhausted: true, modelPrefix: "fake/" });
  });

  it("stops at the budget and at the turn limit", async () => {
    const pricey = await setup([{ tool_calls: [{ name: "list_files", args: {} }], cost: 5 }]);
    expect(await pricey.adapter.run(pricey.ctx, collect().io)).toMatchObject({ error: { kind: "budget_exceeded" } });

    const looping = await setup([{ tool_calls: [{ name: "list_files", args: {} }] }]);
    const result = await looping.adapter.run({ ...looping.ctx, budget: { ...looping.ctx.budget, maxTurns: 3 } }, collect().io);
    expect(result).toMatchObject({ status: "failed", error: { kind: "fatal" } });
    expect(looping.server.requests).toHaveLength(3);
  });

  it("requires a <provider>/<model> id with a configured provider", async () => {
    const { adapter, ctx } = await setup([{ content: "x" }]);
    expect(await adapter.run({ ...ctx, model: "nope/x" }, collect().io)).toMatchObject({ error: { kind: "fatal" } });
    const { model: _model, ...noModel } = ctx;
    expect((await adapter.run(noModel, collect().io)).error?.message).toContain("needs a model");
  });
});

describe("SandboxTools confinement", () => {
  const grant = taskContext().tools;

  it("refuses paths outside the worktree, symlink escapes and .git writes", async () => {
    const repo = makeRepo();
    const outside = join(tmpdir(), `navarch-outside-${Date.now()}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(repo, "link"));
    const tools = new SandboxTools(repo, grant);

    for (const [name, args] of [
      ["read_file", { path: "../../etc/passwd" }],
      ["read_file", { path: "/etc/passwd" }],
      ["read_file", { path: "link/secret.txt" }],
      ["write_file", { path: "link/new.txt", content: "x" }],
      ["write_file", { path: ".git/config", content: "x" }],
    ] as const) {
      const out = await tools.call(name, JSON.stringify(args));
      expect(out.denied, `${name} ${JSON.stringify(args)}`).toBeDefined();
      expect(out.output).toMatch(/^denied:/);
    }
  });

  it("runs allowlisted commands without a shell and reports exit codes", async () => {
    const repo = makeRepo();
    const tools = new SandboxTools(repo, { ...grant, allowCommands: ["git status *", "git log *"] });
    const ok = await tools.call("run_command", JSON.stringify({ command: "git log --oneline" }));
    expect(ok.output).toMatch(/^exit 0\n[0-9a-f]+ init/);
    const chained = await tools.call("run_command", JSON.stringify({ command: "git status; rm -rf ." }));
    expect(chained.denied).toBeDefined();
  });

  it("does not offer edit or command tools that are not granted", async () => {
    const tools = (await import("../src/tools.ts")).toolSpecs({ ...grant, editFiles: false, allowCommands: [] });
    expect(tools.map((t) => t.function.name)).toEqual(["list_files", "read_file", "search"]);
  });

  it("splits quoted arguments", () => {
    expect(splitCommand(`git commit -m "fix: the thing" --no-verify`)).toEqual(["git", "commit", "-m", "fix: the thing", "--no-verify"]);
    expect(splitCommand(`echo ''`)).toEqual(["echo", ""]);
  });
});
