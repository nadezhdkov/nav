import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collect, fakeCli, taskContext } from "../../kit/test/fake-cli.ts";
import { GeminiCliAdapter, geminiPolicy } from "../src/index.ts";

const script = fileURLToPath(new URL("./fixtures/fake-gemini.mjs", import.meta.url));

describe("geminiPolicy", () => {
  it("denies push and network, allows only the listed commands", () => {
    const toml = geminiPolicy(taskContext().tools);
    expect(toml).toContain('toolName = "run_shell_command"\ncommandPrefix = "git push"\ndecision = "deny"');
    expect(toml).toContain('toolName = "web_fetch"\ndecision = "deny"');
    expect(toml).toContain('commandRegex = "^npm test$"\ndecision = "allow"');
    expect(toml).toContain('commandPrefix = "npm run"\ndecision = "allow"');
  });
});

describe("GeminiCliAdapter (contract, fake CLI)", () => {
  it("runs headless in the sandbox with the policy file and normalizes the stream", async () => {
    const fake = fakeCli(script, "edit");
    const ctx = taskContext();
    const { events, io } = collect();
    const result = await new GeminiCliAdapter(fake.options).run(ctx, io);

    expect(result).toMatchObject({ status: "succeeded", summary: "Created notes.md." });
    expect(result.usage).toEqual([{ model: "gemini-flash", tokens_in: 100, tokens_out: 30, cached_tokens: 10, cost: 0 }]);
    expect(existsSync(join(ctx.sandbox.path, "notes.md"))).toBe(true);

    const [call] = fake.calls();
    expect(call?.cwd).toBe(ctx.sandbox.path);
    expect(call?.args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--approval-mode", "auto_edit", "--session-id"]));
    expect(call?.policy).toContain('commandPrefix = "git push"');
    expect(events).toContainEqual({ kind: "progress", message: "Writing notes.md" });
    expect(events).toContainEqual({ kind: "progress", message: "write_file notes.md", tool: "write_file" });
    expect(events).toContainEqual({ kind: "denied", tool: "run_shell_command", input: "run_shell_command git push" });
    expect(events.find((e) => e.kind === "resume_token")).toBeDefined();
  });

  it("resumes by session id and falls back to a new session when it is gone", async () => {
    const fake = fakeCli(script, "missing-session");
    const { events, io } = collect();
    const result = await new GeminiCliAdapter(fake.options).run(taskContext({ resumeToken: "old-session" }), io);
    expect(result.status).toBe("succeeded");
    const [first, second] = fake.calls();
    expect(first?.args).toEqual(expect.arrayContaining(["--resume", "old-session"]));
    expect(second?.args).toContain("--session-id");
    expect(events.some((e) => e.kind === "progress" && e.message.includes("previous session not found"))).toBe(true);
  });

  it("classifies an exhausted free quota as rate limited", async () => {
    const result = await new GeminiCliAdapter(fakeCli(script, "quota").options).run(taskContext(), collect().io);
    expect(result).toMatchObject({ status: "failed", error: { kind: "rate_limited" } });
  });

  it("cancels a running task", async () => {
    const fake = fakeCli(script, "slow");
    const adapter = new GeminiCliAdapter(fake.options);
    const running = adapter.run(taskContext(), collect().io);
    while (!existsSync(join(fake.stateDir, "started"))) await new Promise((r) => setTimeout(r, 20));
    await adapter.cancel("task_1");
    expect(await running).toMatchObject({ status: "failed", error: { kind: "cancelled" } });
  });
});
