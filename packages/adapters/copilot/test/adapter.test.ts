import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collect, fakeCli, taskContext } from "../../kit/test/fake-cli.ts";
import { copilotRules, CopilotAdapter, nextMonthlyReset, parseCopilotLine } from "../src/index.ts";

const script = fileURLToPath(new URL("./fixtures/fake-copilot.mjs", import.meta.url));

describe("CopilotAdapter (contract, fake CLI)", () => {
  it("runs copilot -p with JSON output, permission rules and no built-in MCP servers", async () => {
    const fake = fakeCli(script, "edit");
    const ctx = taskContext();
    const { events, io } = collect();
    const result = await new CopilotAdapter(fake.options).run(ctx, io);

    expect(result).toMatchObject({ status: "succeeded", summary: "Added copilot.txt." });
    expect(result.usage).toEqual([{ model: "gpt-6-luna", tokens_in: 300, tokens_out: 20, cached_tokens: 100, cost: 0 }]);
    expect(existsSync(join(ctx.sandbox.path, "copilot.txt"))).toBe(true);

    const [call] = fake.calls();
    expect(call?.cwd).toBe(ctx.sandbox.path);
    expect(call?.prompt).toBe("do the task");
    expect(call?.args).toEqual(
      expect.arrayContaining([
        "--output-format",
        "json",
        "--no-ask-user",
        "--disable-builtin-mcps",
        "--disallow-temp-dir",
        "--allow-tool=write",
        "--allow-tool=shell(npm test)",
        "--allow-tool=shell(npm run:*)",
        "--deny-tool=shell(git push:*)",
        "--deny-tool=url",
      ]),
    );
    expect(call?.args).not.toContain("--allow-all-tools");
    const sessionId = call!.args[call!.args.indexOf("--session-id") + 1];
    expect(events).toContainEqual({ kind: "resume_token", token: sessionId });
    expect(events).toContainEqual({ kind: "denied", tool: "shell", input: "ls && printf hi > x.txt" });
    expect(events).toContainEqual({ kind: "progress", message: "$ ls", tool: "shell" });
    expect(events).toContainEqual({ kind: "progress", message: `edited ${join(ctx.sandbox.path, "copilot.txt")}`, tool: "edit" });
  });

  it("resumes with --resume <id> and starts a new session when it is gone", async () => {
    const fake = fakeCli(script, "missing-session");
    const result = await new CopilotAdapter(fake.options).run(taskContext({ resumeToken: "old-session" }), collect().io);
    expect(result.status).toBe("succeeded");
    const [first, second] = fake.calls();
    expect(first?.args).toEqual(expect.arrayContaining(["--resume", "old-session"]));
    expect(first?.prompt).toMatch(/interrupted/);
    expect(second?.args).toContain("--session-id");
    expect(second?.args).not.toContain("--resume");
  });

  it("waits for the monthly reset when premium requests run out", async () => {
    const { events, io } = collect();
    const result = await new CopilotAdapter(fakeCli(script, "quota").options).run(taskContext(), io);
    const resetsAt = nextMonthlyReset();
    expect(result.error).toMatchObject({ kind: "rate_limited", retry_at: resetsAt });
    expect(events).toContainEqual({ kind: "quota", window: "premium_requests_monthly", resetsAt, exhausted: true });
  });

  it("loads a per-task permission hook that allows allowlisted commands of more than one word", async () => {
    // Copilot matches `shell(make lint)` against the command name only, so it never allowed `make lint`.
    const fake = fakeCli(script, "hook");
    const ctx = taskContext({ tools: { editFiles: true, allowCommands: ["make lint"], denyCommands: [], denyPaths: [], network: false } });
    const result = await new CopilotAdapter(fake.options).run(ctx, collect().io);
    expect(result.status).toBe("succeeded");

    const seen = JSON.parse(readFileSync(join(fake.stateDir, "hook.json"), "utf8"));
    expect(fake.calls()[0]?.args).toEqual(expect.arrayContaining(["--plugin-dir", seen.dir]));
    expect(seen.dir.startsWith(ctx.sandbox.path)).toBe(false);
    expect(seen.manifest.name).toBe("navarch-permissions");
    expect(seen.entry).toMatchObject({ type: "command", matcher: "bash" });
    expect(seen.answers["make lint"]).toEqual({ status: 0, output: { behavior: "allow" } });
    expect(seen.answers["make deploy"]).toEqual({ status: 0, output: {} });
    // The plugin lives only as long as the attempt.
    expect(existsSync(seen.dir)).toBe(false);
  });

  it("denies writes and URLs for a read-only grant", () => {
    const rules = copilotRules({ editFiles: false, allowCommands: ["git status"], denyCommands: [], denyPaths: ["~/.ssh"], network: false });
    expect(rules.allow).toEqual(["shell(git status)"]);
    expect(rules.deny).toEqual([`write(${homedir()}/.ssh)`, "url", "write"]);
  });

  it("computes the next monthly reset in UTC", () => {
    expect(nextMonthlyReset(new Date("2026-10-14T23:58:00Z"))).toBe("2026-11-01T00:00:00.000Z");
    expect(nextMonthlyReset(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01T00:00:00.000Z");
  });

  it("parses real Copilot CLI 1.0.98 lines", () => {
    expect(
      parseCopilotLine(
        '{"type":"result","timestamp":"2026-10-14T23:58:09.005Z","sessionId":"381ce96a-6de5-4684-8161-8ef451a212e0","exitCode":0,"usage":{"premiumRequests":1,"totalApiDurationMs":6258}}',
      ),
    ).toEqual({ kind: "result", sessionId: "381ce96a-6de5-4684-8161-8ef451a212e0", exitCode: 0, premiumRequests: 1 });
    expect(parseCopilotLine('{"type":"session.background_tasks_changed","data":{},"ephemeral":true}')).toBeUndefined();
    expect(parseCopilotLine('{"type":"assistant.message","data":{"content":"","toolRequests":[]}}')).toBeUndefined();
  });

  it("declares exact enforcement", () => {
    expect(new CopilotAdapter().capabilities()).toMatchObject({ resumable: true, enforcement: "exact" });
  });
});
