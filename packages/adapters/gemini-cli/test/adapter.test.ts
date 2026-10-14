import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collect, fakeCli, taskContext } from "../../kit/test/fake-cli.ts";
import { GeminiCliAdapter, geminiPolicy } from "../src/index.ts";

const script = fileURLToPath(new URL("./fixtures/fake-gemini.mjs", import.meta.url));

/** A user home with an AI Studio key in `~/.gemini/.env`, and a root for per-task Gemini homes. */
function homes(withKey = true) {
  const userHome = mkdtempSync(join(tmpdir(), "navarch-user-"));
  if (withKey) {
    mkdirSync(join(userHome, ".gemini"));
    writeFileSync(join(userHome, ".gemini", ".env"), "GEMINI_API_KEY=test-key\n");
  }
  return { userHome, homeRoot: mkdtempSync(join(tmpdir(), "navarch-gemini-homes-")) };
}

/** Fake CLI options plus hermetic homes. */
function options(scenario: string, withKey = true) {
  const fake = fakeCli(script, scenario);
  return { fake, options: { ...fake.options, ...homes(withKey) } };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    const { fake, options: opts } = options("edit");
    const ctx = taskContext();
    const { events, io } = collect();
    const result = await new GeminiCliAdapter(opts).run(ctx, io);

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
    const { fake, options: opts } = options("missing-session");
    const { events, io } = collect();
    const result = await new GeminiCliAdapter(opts).run(taskContext({ resumeToken: "old-session" }), io);
    expect(result.status).toBe("succeeded");
    const [first, second] = fake.calls();
    expect(first?.args).toEqual(expect.arrayContaining(["--resume", "old-session"]));
    expect(second?.args).toContain("--session-id");
    expect(events.some((e) => e.kind === "progress" && e.message.includes("previous session not found"))).toBe(true);
  });

  it("selects API-key auth in a per-task Gemini home, whatever the user's own auth choice", async () => {
    const { fake, options: opts } = options("edit");
    await new GeminiCliAdapter(opts).run(taskContext(), collect().io);
    const [call] = fake.calls() as { geminiHome?: string; settings?: unknown; envFile?: string }[];
    expect(call?.geminiHome?.startsWith(opts.homeRoot)).toBe(true);
    expect(call?.settings).toEqual({ security: { auth: { selectedType: "gemini-api-key" } } });
    expect(call?.envFile).toBe("GEMINI_API_KEY=test-key\n");
  });

  it("fails without starting the CLI when no API key is available", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const { fake, options: opts } = options("edit", false);
    const result = await new GeminiCliAdapter(opts).run(taskContext(), collect().io);
    expect(result).toMatchObject({ status: "failed", error: { kind: "fatal" } });
    expect(result.error?.message).toContain("GEMINI_API_KEY");
    expect(fake.calls()).toEqual([]);
  });

  it("keeps the task home after a failure so a retry resumes, and removes it after success", async () => {
    const failing = options("quota");
    const ctx = taskContext();
    await new GeminiCliAdapter(failing.options).run(ctx, collect().io);
    const [failed] = failing.fake.calls() as { geminiHome?: string }[];
    expect(existsSync(failed?.geminiHome ?? "")).toBe(true);

    const passing = options("edit");
    await new GeminiCliAdapter(passing.options).run(ctx, collect().io);
    const [passed] = passing.fake.calls() as { geminiHome?: string }[];
    expect(existsSync(passed?.geminiHome ?? "")).toBe(false);
  });

  it("classifies an exhausted free quota as rate limited", async () => {
    const result = await new GeminiCliAdapter(options("quota").options).run(taskContext(), collect().io);
    expect(result).toMatchObject({ status: "failed", error: { kind: "rate_limited" } });
  });

  it("cancels a running task", async () => {
    const { fake, options: opts } = options("slow");
    const adapter = new GeminiCliAdapter(opts);
    const running = adapter.run(taskContext(), collect().io);
    while (!existsSync(join(fake.stateDir, "started"))) await new Promise((r) => setTimeout(r, 20));
    await adapter.cancel("task_1");
    expect(await running).toMatchObject({ status: "failed", error: { kind: "cancelled" } });
  });
});
