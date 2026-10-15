import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ToolGrant } from "@navarch/contracts";
import { collect, fakeCli, taskContext } from "../../kit/test/fake-cli.ts";
import { GrokAdapter, grokPermissions, guardDecision, parseGrokLine, shellAllowed } from "../src/index.ts";

const script = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));
const hookScript = fileURLToPath(new URL("../src/guard-hook.ts", import.meta.url));

type Call = {
  args: string[];
  cwd: string;
  prompt?: string;
  env: Record<string, string | undefined>;
  settings?: string;
  hooks?: string;
  config?: string;
  authLinked: boolean;
};

/** A fake operator Grok home with a login, and a root for per-task homes. */
function grokHomes() {
  const dir = mkdtempSync(join(tmpdir(), "navarch-grok-test-"));
  const userGrokHome = join(dir, "operator-grok");
  mkdirSync(userGrokHome);
  writeFileSync(join(userGrokHome, "auth.json"), "{}");
  return { userGrokHome, homeRoot: join(dir, "homes") };
}

const grant: ToolGrant = { editFiles: false, allowCommands: ["npm test", "npm run *"], denyCommands: ["git push"], denyPaths: ["~/.ssh"], network: false };

describe("GrokAdapter (contract, fake CLI)", () => {
  it("runs grok headless in its own home, with the grant as rules and a guard hook, and no operator config", async () => {
    const fake = fakeCli(script, "edit");
    const homes = grokHomes();
    const ctx = taskContext({ model: "grok-4.7" });
    const { events, io } = collect();
    process.env.GITHUB_TOKEN = "ghp_should_not_leak";
    process.env.GROK_FOLDER_TRUST = "0";
    let result;
    try {
      result = await new GrokAdapter({ ...fake.options, ...homes }).run(ctx, io);
    } finally {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GROK_FOLDER_TRUST;
    }

    expect(result).toMatchObject({ status: "succeeded", summary: "Added grok.txt." });
    expect(result.usage).toEqual([{ model: "grok-4.7", tokens_in: 1000, tokens_out: 100, cached_tokens: 500, cost: 0.04, billing: "plan" }]);
    expect(existsSync(join(ctx.sandbox.path, "grok.txt"))).toBe(true);

    const [call] = fake.calls() as Call[];
    expect(call?.cwd).toBe(ctx.sandbox.path);
    expect(call?.prompt).toBe("do the task");
    expect(call?.args.slice(0, 1)).toEqual(["--prompt-file"]);
    expect(call?.args).toEqual(expect.arrayContaining(["--output-format", "streaming-messages-json", "--model", "grok-4.7", "--no-subagents", "--disable-web-search"]));
    const removed = call!.args[call!.args.indexOf("--disallowed-tools") + 1]!.split(",");
    expect(removed).toEqual(expect.arrayContaining(["web_search", "web_fetch", "send_feedback", "image_gen"]));
    expect(removed).not.toContain("search_replace");
    const sessionId = call!.args[call!.args.indexOf("--session-id") + 1];
    expect(events).toContainEqual({ kind: "resume_token", token: sessionId });

    // HOME and GROK_HOME are the task's own; only the login is the operator's.
    const home = join(homes.homeRoot, "run_1-task_1");
    expect(call?.env).toMatchObject({ home, grokHome: join(home, ".grok"), memory: "0" });
    expect(call?.env.folderTrust).toBeUndefined();
    expect(call?.env.githubToken).toBeUndefined();
    expect(call?.authLinked).toBe(true);
    expect(call?.config).toMatch(/load_envrc = false/);
    expect(JSON.parse(call!.settings!)).toEqual({ permissions: grokPermissions(ctx.tools) });
    const hook = JSON.parse(call!.hooks!).hooks.PreToolUse[0].hooks[0];
    expect(hook).toMatchObject({ type: "command", timeout: 30 });
    expect(hook.command).toContain("guard-hook.ts");
    // A succeeded task needs no session to resume: its home is removed.
    expect(existsSync(home)).toBe(false);

    expect(events).toContainEqual({ kind: "progress", message: "Looking at the project." });
    expect(events).toContainEqual({ kind: "denied", tool: "run_terminal_command", input: "run_terminal_command touch x" });
    expect(events).toContainEqual({ kind: "progress", message: `write ${join(ctx.sandbox.path, "grok.txt")}`, tool: "write" });
  });

  it("links the operator's login into the task home instead of copying it", async () => {
    const fake = fakeCli(script, "slow");
    const homes = grokHomes();
    const adapter = new GrokAdapter({ ...fake.options, ...homes });
    const ctx = taskContext();
    const running = adapter.run(ctx, collect().io);
    await expect.poll(() => existsSync(join(fake.stateDir, "started"))).toBe(true);
    expect(readlinkSync(join(adapter.taskHome(ctx), ".grok", "auth.json"))).toBe(join(homes.userGrokHome, "auth.json"));
    await adapter.cancel(ctx.taskId);
    expect((await running).error?.kind).toBe("cancelled");
  });

  it("resumes with --resume <id>, and starts a new session when Grok no longer has it", async () => {
    const fake = fakeCli(script, "missing-session");
    const { events, io } = collect();
    const result = await new GrokAdapter({ ...fake.options, ...grokHomes() }).run(taskContext({ resumeToken: "old-session", resumePrompt: "also add tests" }), io);
    expect(result.status).toBe("succeeded");
    const [first, second] = fake.calls() as Call[];
    expect(first?.args).toEqual(expect.arrayContaining(["--resume", "old-session"]));
    expect(first?.prompt).toBe("also add tests");
    expect(second?.args).not.toContain("--resume");
    expect(second?.prompt).toBe("do the task");
    expect(events).toContainEqual({ kind: "progress", message: "previous session not found, starting a new one" });
  });

  it("counts use with an xAI API key as billed", async () => {
    const result = await new GrokAdapter({ ...fakeCli(script, "api-key").options, ...grokHomes() }).run(taskContext(), collect().io);
    expect(result.usage[0]?.billing).toBe("metered");
  });

  it("reports a rate limit with its reset time and keeps the home for a retry", async () => {
    const fake = fakeCli(script, "rate-limit");
    const homes = grokHomes();
    const adapter = new GrokAdapter({ ...fake.options, ...homes });
    const ctx = taskContext();
    const before = Date.now();
    const result = await adapter.run(ctx, collect().io);
    expect(result.error?.kind).toBe("rate_limited");
    expect(Date.parse(result.error!.retry_at!)).toBeGreaterThanOrEqual(before + 30_000);
    expect(existsSync(adapter.taskHome(ctx))).toBe(true);
  });

  it("is unavailable until the operator signs in", () => {
    const dir = mkdtempSync(join(tmpdir(), "navarch-grok-test-"));
    const key = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      expect(new GrokAdapter({ userGrokHome: dir }).unavailableReason()).toMatch(/grok login/);
      writeFileSync(join(dir, "auth.json"), "{}");
      expect(new GrokAdapter({ userGrokHome: dir }).unavailableReason()).toBeUndefined();
    } finally {
      if (key !== undefined) process.env.XAI_API_KEY = key;
    }
  });

  it("removes edit tools from a read-only task and keeps web tools when the grant has network", async () => {
    const fake = fakeCli(script, "edit");
    await new GrokAdapter({ ...fake.options, ...grokHomes() }).run(taskContext({ tools: { ...grant, network: true } }), collect().io);
    const [call] = fake.calls() as Call[];
    const removed = call!.args[call!.args.indexOf("--disallowed-tools") + 1]!.split(",");
    expect(removed).toEqual(expect.arrayContaining(["search_replace", "write"]));
    expect(removed).not.toContain("web_search");
    expect(call?.args).not.toContain("--disable-web-search");
  });
});

describe("grant translation and guard", () => {
  it("translates the grant into deny-by-default rules, with ~ as the operator's real home", () => {
    expect(grokPermissions(grant, "/home/op")).toEqual({
      defaultMode: "dontAsk",
      allow: ["Bash(npm test)", "Bash(npm run)", "Bash(npm run *)"],
      deny: [
        "Bash(git push)",
        "Bash(git push *)",
        "Read(/home/op/.ssh/**)",
        "Edit(/home/op/.ssh/**)",
        "Write(/home/op/.ssh/**)",
        "Grep(/home/op/.ssh/**)",
        "WebFetch",
        "Edit",
        "Write",
      ],
    });
    expect(grokPermissions({ ...grant, editFiles: true, network: true }, "/home/op").allow.slice(0, 2)).toEqual(["Edit", "Write"]);
  });

  it("allows only allowlisted or read-only commands, every segment of a chain, nothing hidden", () => {
    const allowed = ["npm test", "npm run lint", "ls", "git status && git diff", "cat README.md | head -5", "rg -o foo src"];
    const refused = [
      "touch x",
      "mkdir d",
      "npm test --watch",
      "ls && touch x",
      "npm run lint; rm -rf /",
      "cat x > y",
      "echo $(touch x)",
      "git push origin main",
      "git diff --output=x",
      "rg --pre sh foo",
      "cat ~/.ssh/id_ed25519",
      `cat ${homedir()}/.ssh/id_ed25519`,
      "",
    ];
    for (const c of allowed) expect(shellAllowed(c, grant), c).toBe(true);
    for (const c of refused) expect(shellAllowed(c, grant), c).toBe(false);
    expect(shellAllowed("git log", { ...grant, denyCommands: ["git log"] })).toBe(false);
  });

  it("keeps edits inside the worktree and reads out of denied paths", () => {
    const policy = { grant: { ...grant, editFiles: true }, root: "/work/tree", home: "/home/op" };
    const decide = (toolName: string, toolInput: Record<string, unknown>) => guardDecision({ toolName, toolInput }, policy)?.decision ?? "pass";
    expect(decide("search_replace", { file_path: "/work/tree/src/a.ts" })).toBe("pass");
    expect(decide("write", { file_path: "src/new.ts" })).toBe("pass");
    expect(decide("write", { file_path: "/work/other/a.ts" })).toBe("deny");
    expect(decide("write", { file_path: "../escape.ts" })).toBe("deny");
    expect(guardDecision({ toolName: "write", toolInput: { file_path: "a.ts" } }, { ...policy, grant })?.reason).toMatch(/may not edit/);
    expect(decide("read_file", { target_file: "/home/op/.ssh/id_rsa" })).toBe("deny");
    expect(decide("read_file", { target_file: "/home/op/.sshx" })).toBe("pass");
    expect(decide("run_terminal_command", { command: "touch x" })).toBe("deny");
    expect(decide("todo_write", { todos: [] })).toBe("pass");
  });

  it("runs as a hook: a deny is JSON on stdout and exit 2, and a broken policy denies", () => {
    const dir = mkdtempSync(join(tmpdir(), "navarch-guard-"));
    const policyFile = join(dir, "policy.json");
    writeFileSync(policyFile, JSON.stringify({ grant, root: dir }));
    const hook = (policy: string, event: unknown) => spawnSync(process.execPath, [hookScript, policy], { input: JSON.stringify(event), encoding: "utf8" });

    const denied = hook(policyFile, { hookEventName: "pre_tool_use", toolName: "run_terminal_command", toolInput: { command: "touch x" } });
    expect(denied.status).toBe(2);
    expect(JSON.parse(denied.stdout)).toMatchObject({ decision: "deny", reason: expect.stringMatching(/Navarch guard/) });

    const passed = hook(policyFile, { toolName: "run_terminal_command", toolInput: { command: "npm test" } });
    expect(passed.status).toBe(0);
    expect(passed.stdout).toBe("");

    const broken = hook(join(dir, "missing.json"), { toolName: "run_terminal_command", toolInput: { command: "npm test" } });
    expect(broken.status).toBe(2);
    expect(JSON.parse(broken.stdout).decision).toBe("deny");
  });
});

describe("parseGrokLine", () => {
  it("parses real Grok CLI 1.0.52 lines", () => {
    expect(
      parseGrokLine(
        '{"type":"system","subtype":"init","session_id":"80412d49-27ab-49a4-bf37-286a3162b715","apiKeySource":"oauth","model":"grok-4.7","permissionMode":"dontAsk","tools":["run_terminal_command","read_file"]}',
      ),
    ).toEqual([{ kind: "init", sessionId: "80412d49-27ab-49a4-bf37-286a3162b715", model: "grok-4.7", apiKeySource: "oauth" }]);
    expect(
      parseGrokLine(
        '{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","model":"grok-4.7","content":[{"type":"thinking","thinking":"The bug is obvious.","signature":"ZhRu"},{"type":"text","text":"`add` subtracts. I\'ll change it to add, then print the file."},{"type":"tool_use","id":"call-4c47-2","name":"search_replace","input":{"file_path":"/repo/calc.py","old_string":"    return a - b","new_string":"    return a + b"}}],"stop_reason":"tool_use"}}',
      ),
    ).toEqual([
      { kind: "text", text: "`add` subtracts. I'll change it to add, then print the file." },
      { kind: "tool", id: "call-4c47-2", name: "search_replace", summary: "search_replace /repo/calc.py" },
    ]);
    expect(
      parseGrokLine(
        '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-6769-1","content":"[{\\"type\\":\\"content\\",\\"content\\":{\\"type\\":\\"text\\",\\"text\\":\\"Tool `run_terminal_command` was not executed: denied by prompt policy (tool not pre-approved)\\"}}]","is_error":true}]},"parent_tool_use_id":null,"session_id":"01a140d6"}',
      ),
    ).toEqual([
      {
        kind: "tool_result",
        toolUseId: "call-6769-1",
        ok: false,
        denied: true,
        message: "Tool `run_terminal_command` was not executed: denied by prompt policy (tool not pre-approved)",
      },
    ]);
    expect(
      parseGrokLine(
        '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-3452-0","content":"{\\"type\\":\\"ReadFile\\",\\"FileContent\\":{\\"content\\":\\"1→def add(a, b):\\"}}","is_error":false}]}}',
      ),
    ).toEqual([{ kind: "tool_result", toolUseId: "call-3452-0", ok: true, denied: false, message: '{"type":"ReadFile","FileContent":{"content":"1→def add(a, b):"}}' }]);
    expect(
      parseGrokLine(
        '{"type":"result","subtype":"success","is_error":false,"duration_ms":20556,"num_turns":3,"result":"One ran.","stop_reason":"end_turn","total_cost_usd":0.056644,"usage":{"input_tokens":15088,"output_tokens":1510,"cache_read_input_tokens":34816,"cache_creation_input_tokens":0},"modelUsage":{"grok-4.7":{"inputTokens":15088,"outputTokens":1510,"cacheReadInputTokens":34816,"cacheCreationInputTokens":0,"webSearchRequests":0,"costUSD":0.056644,"contextWindow":256000}},"session_id":"01a140d6"}',
      ),
    ).toEqual([
      {
        kind: "result",
        result: {
          ok: true,
          subtype: "success",
          text: "One ran.",
          stopReason: "end_turn",
          errors: [],
          sessionId: "01a140d6",
          usage: [{ model: "grok-4.7", tokens_in: 15088, tokens_out: 1510, cached_tokens: 34816, cost: 0.056644 }],
        },
      },
    ]);
    expect(
      parseGrokLine(
        '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":2,"stop_reason":"cancelled","total_cost_usd":0.040516,"usage":{"input_tokens":14950,"output_tokens":564,"cache_read_input_tokens":14464,"cache_creation_input_tokens":0},"modelUsage":{"grok-4.7":{"inputTokens":14950,"outputTokens":564,"cacheReadInputTokens":14464,"cacheCreationInputTokens":0,"costUSD":0.040516}},"errors":["cancelled"],"session_id":"80412d49"}',
      )[0],
    ).toMatchObject({ kind: "result", result: { ok: false, subtype: "error_during_execution", stopReason: "cancelled", errors: ["cancelled"] } });
    expect(parseGrokLine("not json")).toEqual([]);
  });
});
