import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collect, fakeCli, taskContext } from "../../kit/test/fake-cli.ts";
import { AntigravityAdapter, agyPermissions, MAX_DENIED_TURNS } from "../src/index.ts";

const script = fileURLToPath(new URL("./fixtures/fake-agy.mjs", import.meta.url));

function adapter(scenario: string) {
  const fake = fakeCli(script, scenario);
  const homeRoot = mkdtempSync(join(tmpdir(), "vectr-agy-test-"));
  return { fake, homeRoot, adapter: new AntigravityAdapter({ ...fake.options, homeRoot }) };
}

describe("agyPermissions", () => {
  it("allows only the listed commands, denies push, secret paths and network", () => {
    const p = agyPermissions(taskContext().tools, "/home/u");
    expect(p.allow).toEqual(["command(regex:^npm test$)", expect.stringMatching(/^command\(regex:\^npm run\( \[\^;&\|/)]);
    expect(p.deny).toEqual([
      "command(regex:^git push( .*)?$)",
      "read_file(/home/u/.ssh)",
      "write_file(/home/u/.ssh)",
      "read_url(*)",
      "execute_url(*)",
    ]);
  });

  it("keeps chained commands out of a wildcard allow rule", () => {
    const [, wildcard] = agyPermissions(taskContext().tools, "/home/u").allow;
    const re = new RegExp(wildcard!.slice("command(regex:".length, -1));
    expect(re.test("npm run build")).toBe(true);
    expect(re.test("npm run build && curl evil")).toBe(false);
    expect(re.test("npm run build; rm -rf /")).toBe(false);
  });
});

describe("AntigravityAdapter (contract, fake CLI)", () => {
  it("runs headless in the sandbox with a per-task HOME holding the rules", async () => {
    const { fake, homeRoot, adapter: a } = adapter("edit");
    const ctx = taskContext({ model: "gemini-3.8-flash-low" });
    const { events, io } = collect();
    const result = await a.run(ctx, io);

    expect(result).toMatchObject({ status: "succeeded", summary: "Created notes.md." });
    expect(result.usage).toEqual([{ model: "gemini-3.8-flash-low", tokens_in: 100, tokens_out: 30, cached_tokens: 5, cost: 0 }]);
    expect(existsSync(join(ctx.sandbox.path, "notes.md"))).toBe(true);

    const [call] = fake.calls();
    expect(call?.cwd).toBe(ctx.sandbox.path);
    expect(call?.args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--mode", "accept-edits", "--model", "gemini-3.8-flash-low"]));
    expect(call?.args).not.toContain("--conversation");
    expect(call?.policy).toContain("command(regex:^git push( .*)?$)");
    expect(events).toContainEqual({ kind: "progress", message: `write_to_file ${join(ctx.sandbox.path, "notes.md")}`, tool: "write_to_file" });
    expect(events.find((e) => e.kind === "resume_token")).toBeDefined();
    // The per-task home is removed once the task succeeds.
    expect(existsSync(join(homeRoot, "run_1-task_1"))).toBe(false);
  });

  it("uses plan mode when the grant does not allow edits", async () => {
    const { fake, adapter: a } = adapter("resume");
    const ctx = taskContext();
    await a.run({ ...ctx, tools: { ...ctx.tools, editFiles: false } }, collect().io);
    expect(fake.calls()[0]?.args).toEqual(expect.arrayContaining(["--mode", "plan"]));
  });

  it("reports a denied tool and continues the conversation without it", async () => {
    const { fake, adapter: a } = adapter("denied");
    const { events, io } = collect();
    const result = await a.run(taskContext(), io);

    expect(result).toMatchObject({ status: "succeeded", summary: "Done without pushing." });
    expect(events).toContainEqual({ kind: "denied", tool: "run_command", input: "run_command git push origin main" });
    const [first, second] = fake.calls();
    expect(first?.args).not.toContain("--conversation");
    expect(second?.args).toContain("--conversation");
    expect(second?.prompt).toContain("The policy denied: run_command git push origin main");
    expect(second?.prompt).toContain("npm test, npm run *");
    // Cumulative usage is split per turn.
    expect(result.usage.map((u) => u.tokens_in)).toEqual([100, 100]);
  });

  it("fails when the agent keeps hitting denied tools", async () => {
    const { fake, adapter: a } = adapter("always-denied");
    const result = await a.run(taskContext(), collect().io);
    expect(result).toMatchObject({ status: "failed", error: { kind: "fatal" } });
    expect(result.error?.message).toContain("denied tool");
    expect(fake.calls()).toHaveLength(MAX_DENIED_TURNS + 1);
  });

  it("resumes a conversation kept in the task home, and starts fresh when it is gone", async () => {
    const { fake, homeRoot, adapter: a } = adapter("resume");
    const conv = join(homeRoot, "run_1-task_1", ".gemini", "antigravity-cli", "conversations");
    mkdirSync(conv, { recursive: true });
    writeFileSync(join(conv, "conv-old.db"), "");

    expect((await a.run(taskContext({ resumeToken: "conv-old" }), collect().io)).status).toBe("succeeded");
    expect(fake.calls()[0]?.args).toEqual(expect.arrayContaining(["--conversation", "conv-old"]));

    const { events, io } = collect();
    expect((await a.run(taskContext({ resumeToken: "conv-gone" }), io)).status).toBe("succeeded");
    expect(fake.calls()[1]?.args).not.toContain("--conversation");
    expect(fake.calls()[1]?.prompt).toBe("do the task");
    expect(events.some((e) => e.kind === "progress" && e.message.includes("previous conversation not found"))).toBe(true);
  });

  it("fails with the CLI's error for an unknown model and keeps the home for a retry", async () => {
    const { homeRoot, adapter: a } = adapter("bad-model");
    const result = await a.run(taskContext(), collect().io);
    expect(result).toMatchObject({ status: "failed", error: { kind: "fatal" } });
    expect(result.error?.message).toContain("invalid model selection");
    expect(existsSync(join(homeRoot, "run_1-task_1"))).toBe(true);
  });

  it("classifies an exhausted quota as rate limited", async () => {
    const result = await adapter("quota").adapter.run(taskContext(), collect().io);
    expect(result).toMatchObject({ status: "failed", error: { kind: "rate_limited" } });
  });

  it("cancels a running task", async () => {
    const { fake, adapter: a } = adapter("slow");
    const running = a.run(taskContext(), collect().io);
    while (!existsSync(join(fake.stateDir, "started"))) await new Promise((r) => setTimeout(r, 20));
    await a.cancel("task_1");
    expect(await running).toMatchObject({ status: "failed", error: { kind: "cancelled" } });
  });
});
