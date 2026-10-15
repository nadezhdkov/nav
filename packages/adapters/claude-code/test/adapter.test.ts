import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, TaskContext } from "@navarch/contracts";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, parseLine } from "../src/index.ts";
import { fakeClaude } from "./fake.ts";

function context(overrides: Partial<TaskContext> = {}): TaskContext {
  const dir = mkdtempSync(join(tmpdir(), "navarch-sbx-"));
  return {
    taskId: "task_1",
    runId: "run_1",
    attempt: 1,
    profile: { id: "implementer", role: "", instructions: "" },
    instructions: "create hello.txt",
    sandbox: { id: "sbx_1", kind: "worktree", path: dir, branch: "navarch/run_1/implement", baseCommit: "abc" },
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

  it("reads the agent's own sub-agents: a Task tool use starts one, its tool result finishes it (ADR 0022)", () => {
    const use = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Task", input: { description: "Explore the API", subagent_type: "Explore", prompt: "…" } }] } });
    expect(parseLine(use)).toContainEqual({ kind: "subagent", id: "toolu_1", description: "Explore the API", status: "started" });
    const done = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "found it" }] } });
    expect(parseLine(done)).toEqual([{ kind: "tool_result", toolUseId: "toolu_1" }]);
    const other = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "a.ts" } }] } });
    expect(parseLine(other).some((i) => i.kind === "subagent")).toBe(false);
  });

  it("reads subscription limits from rate_limit_event (captured from claude 2.x)", () => {
    const line =
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1792400400,"rateLimitType":"seven_day","utilization":0.92,"overageStatus":"rejected","isUsingOverage":false,"surpassedThreshold":0.75,"unifiedWindows":{"five_hour":{"utilization":0.5,"resetsAt":1792005600},"seven_day":{"utilization":0.92,"resetsAt":1792400400}},"overageEnabled":false}}';
    expect(parseLine(line)).toEqual([
      {
        kind: "quota",
        limit: {
          status: "allowed_warning",
          type: "seven_day",
          resetsAt: "2026-10-19T09:00:00.000Z",
          windows: [
            { window: "five_hour", utilization: 0.5, resetsAt: "2026-10-14T19:20:00.000Z" },
            { window: "seven_day", utilization: 0.92, resetsAt: "2026-10-19T09:00:00.000Z" },
          ],
        },
      },
    ]);
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
    // The user's own ~/.claude (CLAUDE.md, hooks, plugins) must not steer a Navarch task.
    expect(argv).toContain("--setting-sources project,local");

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

    const { events, io } = collect();
    const weekly = await new ClaudeCodeAdapter(fakeClaude("limit-weekly").options).run(context(), io);
    expect(weekly).toMatchObject({ status: "failed", error: { kind: "rate_limited" } });
    expect(Date.parse(weekly.error!.retry_at!)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(events).toContainEqual(expect.objectContaining({ kind: "quota", window: "seven_day", utilization: 1, exhausted: true }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "quota", window: "five_hour", exhausted: false }));

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
