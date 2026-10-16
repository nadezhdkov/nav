import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { opencodePermission, parseOpencodeLine } from "@navarch/adapter-opencode";
import { collect, fakeCli, taskContext } from "../../kit/test/fake-cli.ts";
import { defaultKiloCommand, KiloAdapter } from "../src/index.ts";

const script = fileURLToPath(new URL("./fixtures/fake-kilo.mjs", import.meta.url));

type Call = { args: string[]; cwd: string; prompt?: string; env: Record<string, string | undefined> };

describe("KiloAdapter (contract, fake CLI)", () => {
  it("runs kilo run with the grant as permission rules and none of the operator's config", async () => {
    const fake = fakeCli(script, "edit");
    const ctx = taskContext({ model: "kilo/kilo-auto/free" });
    const { events, io } = collect();
    process.env.GITHUB_TOKEN = "ghp_should_not_leak";
    process.env.KILO_CONFIG = "/home/operator/kilo.json";
    process.env.KILO_PROVIDER = "anthropic";
    let result;
    try {
      result = await new KiloAdapter(fake.options).run(ctx, io);
    } finally {
      delete process.env.GITHUB_TOKEN;
      delete process.env.KILO_CONFIG;
      delete process.env.KILO_PROVIDER;
    }

    expect(result).toMatchObject({ status: "succeeded", summary: "Added kilo.txt." });
    expect(result.usage).toEqual([{ model: "kilo/kilo-auto/free", tokens_in: 300, tokens_out: 35, cached_tokens: 150, cost: 0 }]);
    expect(existsSync(join(ctx.sandbox.path, "kilo.txt"))).toBe(true);

    const [call] = fake.calls() as Call[];
    expect(call?.cwd).toBe(ctx.sandbox.path);
    expect(call?.env.pwd).toBe(ctx.sandbox.path);
    expect(call?.prompt).toBe("do the task");
    expect(call?.args.slice(0, 4)).toEqual(["run", "--format", "json", "--pure"]);
    expect(call?.args).toEqual(expect.arrayContaining(["--model", "kilo/kilo-auto/free"]));
    expect(call?.args).not.toContain("--auto");
    expect(call?.args).not.toContain("--session");
    expect(JSON.parse(call!.env.config!)).toEqual({ permission: opencodePermission(ctx.tools) });
    expect(call?.env).toMatchObject({ noProject: "1", noClaude: "1", noSkills: "1" });
    expect(call?.env.configDir).toMatch(/navarch-kilo-/);
    expect(call?.env.xdgConfig).toBe(call?.env.configDir);
    expect(existsSync(call!.env.configDir!)).toBe(false);
    expect(call?.env.operatorConfig).toBeUndefined();
    expect(call?.env.provider).toBeUndefined();
    expect(call?.env.githubToken).toBeUndefined();

    expect(events).toContainEqual({ kind: "resume_token", token: "ses_kilo0001" });
    expect(events).toContainEqual({ kind: "progress", message: "\n\nLooking." });
    expect(events).toContainEqual({ kind: "denied", tool: "bash", input: "ls > list.txt" });
    expect(events).toContainEqual({ kind: "denied", tool: "write", input: join(ctx.sandbox.path, "x.txt") });
    expect(events).toContainEqual({ kind: "progress", message: "$ ls", tool: "shell" });
    expect(events).toContainEqual({ kind: "progress", message: `edited ${join(ctx.sandbox.path, "kilo.txt")}`, tool: "edit" });
  });

  it("resumes with --session <id>, and starts a new session when Kilo no longer has it", async () => {
    const fake = fakeCli(script, "missing-session");
    const { events, io } = collect();
    const result = await new KiloAdapter(fake.options).run(taskContext({ resumeToken: "ses_old" }), io);
    expect(result.status).toBe("succeeded");
    const [first, second] = fake.calls() as Call[];
    expect(first?.args).toEqual(expect.arrayContaining(["--session", "ses_old"]));
    expect(first?.prompt).toMatch(/interrupted/);
    expect(second?.args).not.toContain("--session");
    expect(second?.prompt).toBe("do the task");
    expect(events).toContainEqual({ kind: "resume_token", token: "ses_kilo0001" });
  });

  it("reports Kilo's last error, and a rate limit with its reset time", async () => {
    const unknown = await new KiloAdapter(fakeCli(script, "unknown-model").options).run(taskContext(), collect().io);
    expect(unknown.error).toMatchObject({ kind: "fatal", message: "UnknownError: Model not found: kilo/nope/none." });

    const before = Date.now();
    const limited = await new KiloAdapter(fakeCli(script, "rate-limit").options).run(taskContext(), collect().io);
    expect(limited.error).toMatchObject({ kind: "rate_limited", message: "APIError: Rate limit exceeded, retry in 30s (HTTP 429)" });
    expect(Date.parse(limited.error!.retry_at!)).toBeGreaterThanOrEqual(before + 30_000);
  });

  it("cancels a running task", async () => {
    const fake = fakeCli(script, "slow");
    const adapter = new KiloAdapter(fake.options);
    const ctx = taskContext();
    const running = adapter.run(ctx, collect().io);
    await expect.poll(() => existsSync(join(fake.stateDir, "started"))).toBe(true);
    await adapter.cancel(ctx.taskId);
    expect((await running).error?.kind).toBe("cancelled");
  });

  it("finds the CLI on PATH, else in ~/.kilo/bin, and says when it is missing", () => {
    // Tests put a stub `kilo` first on PATH, so the real CLI in ~/.kilo/bin is never reached.
    expect(defaultKiloCommand()).toBe("kilo");

    const home = mkdtempSync(join(tmpdir(), "navarch-kilo-home-"));
    expect(defaultKiloCommand({ PATH: "/nonexistent" }, home)).toBe("kilo");
    mkdirSync(join(home, ".kilo", "bin"), { recursive: true });
    writeFileSync(join(home, ".kilo", "bin", "kilo"), "#!/bin/sh\n");
    chmodSync(join(home, ".kilo", "bin", "kilo"), 0o755);
    expect(defaultKiloCommand({ PATH: "/nonexistent" }, home)).toBe(join(home, ".kilo", "bin", "kilo"));

    expect(new KiloAdapter({ command: join(home, ".kilo", "bin", "kilo") }).unavailableReason()).toBeUndefined();
    expect(new KiloAdapter({ command: "kilo" }).unavailableReason()).toBeUndefined();
    expect(new KiloAdapter({ command: join(home, "missing") }).unavailableReason()).toMatch(/kilo CLI not found/);
    expect(new KiloAdapter({ command: "kilo-not-installed" }).unavailableReason()).toMatch(/adapters\.kilo\.command/);
  });

  it("declares exact enforcement and metered billing (free models cost $0)", () => {
    expect(new KiloAdapter().capabilities()).toMatchObject({ enforcement: "exact", billing: "metered", resumable: true });
    expect(new KiloAdapter().id).toBe("kilo");
  });

  it("parses real Kilo 7.8.12 lines", () => {
    expect(
      parseOpencodeLine(
        '{"type":"tool_use","timestamp":1792179500000,"sessionID":"ses_eb9c73610ffeqvs1RgTtKlmBn3","part":{"type":"tool","tool":"bash","state":{"status":"error","input":{"command":"cat a.txt"},"error":"The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules {\\"permission\\":\\"bash\\",\\"pattern\\":\\"*\\",\\"action\\":\\"deny\\"}"}}}',
      ),
    ).toMatchObject({ kind: "tool", tool: "bash", ok: false, denied: true, command: "cat a.txt" });
    expect(
      parseOpencodeLine(
        '{"type":"step_finish","timestamp":1792179371794,"sessionID":"ses_eb9c92dfeffeK8G8eJocB1j479","part":{"type":"step-finish","reason":"stop","model":{"providerID":"kilo","modelID":"dots-studio/dots-3-note-preview:free"},"cost":0,"tokens":{"total":20389,"input":402,"output":4,"reasoning":15,"cache":{"read":19968,"write":0}}}}',
      ),
    ).toEqual({ kind: "usage", tokensIn: 402, tokensOut: 19, cached: 19968, cost: 0 });
    expect(
      parseOpencodeLine('{"type":"error","timestamp":1792179670449,"sessionID":"ses_x","error":{"name":"UnknownError","data":{"message":"Model not found: kilo/nope/none."}}}'),
    ).toEqual({ kind: "failed", message: "UnknownError: Model not found: kilo/nope/none." });
  });
});
