import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, TaskContext } from "@vectr/contracts";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, parseLine } from "../src/index.ts";
import { fakeClaude } from "./fake.ts";

function context(overrides: Partial<TaskContext> = {}): TaskContext {
  const dir = mkdtempSync(join(tmpdir(), "vectr-sbx-"));
  return {
    taskId: "task_1",
    runId: "run_1",
    attempt: 1,
    profile: { id: "implementer", role: "", instructions: "" },
    instructions: "create hello.txt",
    sandbox: { id: "sbx_1", kind: "worktree", path: dir, branch: "vectr/run_1/implement", baseCommit: "abc" },
    tools: { editFiles: true, allowCommands: ["npm test", "npm run *"], denyCommands: ["git push"], denyPaths: ["~/.ssh"], network: false },
    budget: { maxCost: 1.5, maxTurns: 0, timeoutMs: 10_000 },
    ...overrides,
  };
}

function collect(): { events: AdapterEvent[]; io: { emit: (e: AdapterEvent) => void } } {
  const events: AdapterEvent[] = [];
  return { events, io: { emit: (e) => events.push(e) } };
}

describe("stream-json parser", () => {
  it("reads init, text, tool use and result; ignores noise", () => {
    expect(parseLine('{"type":"system","subtype":"init","session_id":"s1","model":"m"}')).toEqual([
      { kind: "init", sessionId: "s1", model: "m" },
    ]);
    expect(parseLine("not json")).toEqual([]);
    const [tool] = parseLine(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"a.ts"}}]}}',
    );
    expect(tool).toEqual({ kind: "tool", name: "Edit", summary: "Edit a.ts" });
    const [res] = parseLine(
      '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.5,"modelUsage":{"m":{"inputTokens":1,"outputTokens":2,"cacheReadInputTokens":3,"costUSD":0.5}}}',
    );
    expect(res).toMatchObject({ kind: "result", result: { ok: true, costUsd: 0.5, usage: [{ model: "m", cost: 0.5 }] } });
  });
});

describe("ClaudeCodeAdapter (contract, fake CLI)", () => {
  it("runs in the sandbox with the granted tools and returns a normalized result", async () => {
    const fake = fakeClaude("edit");
    const adapter = new ClaudeCodeAdapter(fake.options);
    const ctx = context();
    const { events, io } = collect();

    const result = await adapter.run(ctx, io);

    expect(result.status).toBe("succeeded");
    expect(result.summary).toBe("Created hello.txt with a greeting.");
    expect(result.usage).toEqual([{ model: "fake-model", tokens_in: 100, tokens_out: 20, cached_tokens: 5, cost: 0.01 }]);
    expect(existsSync(join(ctx.sandbox.path, "hello.txt"))).toBe(true);

    const [call] = fake.calls();
    expect(call?.cwd).toBe(ctx.sandbox.path);
    expect(call?.prompt).toBe("create hello.txt");
    expect(call?.args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--session-id"]));
    const argv = call?.args.join(" ") ?? "";
    expect(argv).toMatch(/--allowedTools Read .*Edit .*Bash\(npm test\) Bash\(npm run:\*\)/);
    expect(argv).toMatch(/--disallowedTools Bash\(git push:\*\) Read\(~\/.ssh\/\*\*\) Edit\(~\/.ssh\/\*\*\) WebFetch WebSearch/);
    expect(call?.args.join(" ")).toContain("--max-budget-usd 1.50");

    const token = events.find((e) => e.kind === "resume_token");
    expect(token?.kind === "resume_token" && call?.args.includes(token.token)).toBe(true);
    expect(events.some((e) => e.kind === "progress" && e.tool === "Write")).toBe(true);
    expect(events.some((e) => e.kind === "log")).toBe(true);
    expect(events).toContainEqual({ kind: "denied", tool: "Bash", input: "Bash python3 check.py" });
  });

  it("resumes the previous session when given a resume token", async () => {
    const fake = fakeClaude("slow");
    const adapter = new ClaudeCodeAdapter(fake.options);
    const result = await adapter.run(context({ resumeToken: "prev-session" }), collect().io);
    expect(result.status).toBe("succeeded");
    expect(fake.calls()[0]?.args).toEqual(expect.arrayContaining(["--resume", "prev-session"]));
  });

  it("classifies failures", async () => {
    const fail = await new ClaudeCodeAdapter(fakeClaude("fail").options).run(context(), collect().io);
    expect(fail).toMatchObject({ status: "failed", error: { kind: "fatal" } });

    const limited = await new ClaudeCodeAdapter(fakeClaude("ratelimit-once").options).run(context(), collect().io);
    expect(limited).toMatchObject({ status: "failed", error: { kind: "rate_limited" } });

    const missing = await new ClaudeCodeAdapter({ command: "/nonexistent/claude" }).run(context(), collect().io);
    expect(missing).toMatchObject({ status: "failed", error: { kind: "fatal" } });
  });

  it("cancels a running task", async () => {
    const fake = fakeClaude("slow");
    const adapter = new ClaudeCodeAdapter(fake.options);
    const running = adapter.run(context(), collect().io);
    while (!existsSync(join(fake.stateDir, "started"))) await new Promise((r) => setTimeout(r, 20));
    await adapter.cancel("task_1");
    expect(await running).toMatchObject({ status: "failed", error: { kind: "cancelled" } });
  });

  it("reports health from --version", async () => {
    const health = await new ClaudeCodeAdapter(fakeClaude("edit").options).healthcheck();
    expect(health).toEqual({ ok: true, detail: "9.9.9 (Fake Claude)" });
  });
});
