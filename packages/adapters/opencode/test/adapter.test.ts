import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collect, fakeCli, taskContext } from "../../kit/test/fake-cli.ts";
import { OpencodeAdapter, opencodePermission, parseOpencodeLine } from "../src/index.ts";

const script = fileURLToPath(new URL("./fixtures/fake-opencode.mjs", import.meta.url));

type Call = { args: string[]; cwd: string; prompt?: string; env: Record<string, string | undefined> };

describe("OpencodeAdapter (contract, fake CLI)", () => {
  it("runs opencode run in a private server, with the grant as permission rules and no operator config", async () => {
    const fake = fakeCli(script, "edit");
    const ctx = taskContext({ model: "opencode/big-pickle" });
    const { events, io } = collect();
    process.env.GITHUB_TOKEN = "ghp_should_not_leak";
    process.env.OPENCODE_CONFIG = "/home/operator/opencode.json";
    let result;
    try {
      result = await new OpencodeAdapter(fake.options).run(ctx, io);
    } finally {
      delete process.env.GITHUB_TOKEN;
      delete process.env.OPENCODE_CONFIG;
    }

    expect(result).toMatchObject({ status: "succeeded", summary: "Added opencode.txt." });
    expect(result.usage).toEqual([{ model: "opencode/big-pickle", tokens_in: 300, tokens_out: 35, cached_tokens: 150, cost: 0 }]);
    expect(existsSync(join(ctx.sandbox.path, "opencode.txt"))).toBe(true);

    const [call] = fake.calls() as Call[];
    expect(call?.cwd).toBe(ctx.sandbox.path);
    // OpenCode takes its project from $PWD; the daemon's own PWD must not leak in.
    expect(call?.env.pwd).toBe(ctx.sandbox.path);
    expect(call?.prompt).toBe("do the task");
    expect(call?.args.slice(0, 4)).toEqual(["run", "--standalone", "--format", "json"]);
    expect(call?.args).toEqual(expect.arrayContaining(["--model", "opencode/big-pickle"]));
    expect(call?.args).not.toContain("--auto");
    expect(call?.args).not.toContain("--session");
    expect(JSON.parse(call!.env.config!)).toEqual({ permission: opencodePermission(ctx.tools) });
    expect(call?.env).toMatchObject({ noProject: "1" });
    expect(call?.env.configDir).toMatch(/navarch-opencode-/);
    expect(existsSync(call!.env.configDir!)).toBe(false);
    expect(call?.env.operatorConfig).toBeUndefined();
    expect(call?.env.githubToken).toBeUndefined();

    expect(events).toContainEqual({ kind: "resume_token", token: "ses_fake0001" });
    expect(events).toContainEqual({ kind: "progress", message: "Looking." });
    expect(events).toContainEqual({ kind: "denied", tool: "shell", input: "ls && touch x" });
    expect(events).toContainEqual({ kind: "progress", message: "$ ls", tool: "shell" });
    expect(events).toContainEqual({ kind: "progress", message: `edited ${join(ctx.sandbox.path, "opencode.txt")}`, tool: "edit" });
  });

  it("resumes with --session <id>, and starts a new session when OpenCode refuses the old one", async () => {
    const fake = fakeCli(script, "foreign-session");
    const { events, io } = collect();
    const result = await new OpencodeAdapter(fake.options).run(taskContext({ resumeToken: "ses_old" }), io);
    expect(result.status).toBe("succeeded");
    const [first, second] = fake.calls() as Call[];
    expect(first?.args).toEqual(expect.arrayContaining(["--session", "ses_old"]));
    expect(first?.prompt).toMatch(/interrupted/);
    expect(second?.args).not.toContain("--session");
    expect(second?.prompt).toBe("do the task");
    expect(events).toContainEqual({ kind: "resume_token", token: "ses_fake0001" });
  });

  it("reports a rate limit with its reset time", async () => {
    const before = Date.now();
    const result = await new OpencodeAdapter(fakeCli(script, "rate-limit").options).run(taskContext(), collect().io);
    expect(result.error?.kind).toBe("rate_limited");
    expect(Date.parse(result.error!.retry_at!)).toBeGreaterThanOrEqual(before + 30_000);
  });

  it("stops after the step that crosses the task's cap, as budget_exceeded (ADR 0030)", async () => {
    const fake = fakeCli(script, "expensive");
    const ctx = taskContext();
    ctx.budget.maxCost = 0.5;
    const started = Date.now();
    const result = await new OpencodeAdapter(fake.options).run(ctx, collect().io);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result).toMatchObject({ status: "failed", error: { kind: "budget_exceeded", message: "spent $0.6000 of $0.50" } });
    expect(result.usage[0]?.cost).toBeCloseTo(0.6);
  });

  it("cancels a running task", async () => {
    const fake = fakeCli(script, "slow");
    const adapter = new OpencodeAdapter(fake.options);
    const ctx = taskContext();
    const running = adapter.run(ctx, collect().io);
    await expect.poll(() => existsSync(join(fake.stateDir, "started"))).toBe(true);
    await adapter.cancel(ctx.taskId);
    expect((await running).error?.kind).toBe("cancelled");
  });

  it("translates the grant: allowlist, deny prefixes, redirections, deny paths, read-only, no network", () => {
    const p = opencodePermission({ editFiles: false, allowCommands: ["git status", "npm run *"], denyCommands: ["git push"], denyPaths: ["~/.ssh"], network: false });
    expect(p).toMatchObject({ "*": "deny", read: "allow", edit: "deny", webfetch: "deny", websearch: "deny", external_directory: "deny" });
    expect(p.bash).toEqual({
      "*": "deny",
      "git status": "allow",
      "npm run": "allow",
      "npm run *": "allow",
      "git push": "deny",
      "git push *": "deny",
      "*>*": "deny",
      "*<*": "deny",
      "*~/.ssh*": "deny",
      [`*${homedir()}/.ssh*`]: "deny",
    });
    // OpenCode applies the last matching rule, so every deny must come after the allows.
    const keys = Object.keys(p.bash as object);
    expect(keys.indexOf("*>*")).toBeGreaterThan(keys.indexOf("npm run *"));
    expect(opencodePermission({ editFiles: true, allowCommands: [], denyCommands: [], denyPaths: [], network: true })).toMatchObject({
      edit: "allow",
      webfetch: "allow",
    });
  });

  it("parses real OpenCode 2.0.29 lines", () => {
    expect(
      parseOpencodeLine(
        '{"type":"tool_use","timestamp":1792026633542,"sessionID":"ses_ec2e3a8fbffeKSibkwwCZ3TSgn","part":{"partID":"prt_13d1c63c40018wL2Q4ZTJ5bEkv","sessionID":"ses_ec2e3a8fbffeKSibkwwCZ3TSgn","messageID":"msg_13d1c5bed001j3qXxfELeqdGrf","type":"tool","id":"call_e5e950ad3f3d4b60b8965c6a","tool":"shell","state":{"status":"error","input":{"command":"touch denied.txt"},"error":"Permission denied: shell","metadata":{"providerCall":{"executed":false},"providerResult":{"executed":false},"rawInput":"{\\"command\\": \\"touch denied.txt\\"}"},"time":{"start":1792026633156,"end":1792026633542}}}}',
      ),
    ).toEqual({ kind: "tool", tool: "shell", ok: false, denied: true, command: "touch denied.txt", error: "Permission denied: shell" });
    expect(
      parseOpencodeLine(
        '{"type":"step_finish","timestamp":1792026633588,"sessionID":"ses_ec2e3a8fbffeKSibkwwCZ3TSgn","part":{"id":"prt_13d1c6574001Bu48ib28FNwNY0","type":"step-finish","reason":"tool-calls","cost":0,"tokens":{"input":2136,"output":178,"reasoning":0,"cache":{"read":256,"write":0}}}}',
      ),
    ).toEqual({ kind: "usage", tokensIn: 2136, tokensOut: 178, cached: 256, cost: 0 });
    expect(
      parseOpencodeLine(
        '{"type":"error","timestamp":1,"sessionID":"ses_x","error":{"type":"provider.auth","message":"OpenCode\'s free tier can only be used from within OpenCode.","status":403}}',
      ),
    ).toEqual({ kind: "failed", message: "provider.auth: OpenCode's free tier can only be used from within OpenCode. (HTTP 403)" });
    expect(parseOpencodeLine('{"type":"error","error":{"type":"provider.no-route","message":"Model unavailable: opencode/x"}}')).toEqual({
      kind: "failed",
      message: "provider.no-route: Model unavailable: opencode/x",
    });
    expect(parseOpencodeLine("not json")).toBeUndefined();
  });
});
