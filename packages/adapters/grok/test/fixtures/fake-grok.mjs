#!/usr/bin/env node
// Stand-in for `grok --prompt-file … --output-format streaming-messages-json`, used by tests.
// Line shapes follow a real Grok CLI 1.0.52 run. Usage: fake-grok.mjs <scenario> <state-dir> [grok args...]
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [scenario, stateDir, ...args] = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("grok 0.0.0-fake");
  process.exit(0);
}
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const home = process.env.HOME;
const grokHome = process.env.GROK_HOME;
const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
appendFileSync(
  join(stateDir, "calls.jsonl"),
  JSON.stringify({
    args,
    cwd: process.cwd(),
    prompt: read(value("--prompt-file")),
    env: {
      home,
      grokHome,
      memory: process.env.GROK_MEMORY,
      folderTrust: process.env.GROK_FOLDER_TRUST,
      githubToken: process.env.GITHUB_TOKEN,
    },
    settings: read(join(home, ".claude", "settings.json")),
    hooks: read(join(grokHome, "hooks", "navarch-guard.json")),
    config: read(join(grokHome, "config.toml")),
    authLinked: existsSync(join(grokHome, "auth.json")),
  }) + "\n",
);

const resumed = value("--resume");
if (resumed && scenario === "missing-session") {
  process.stderr.write(`Session "${resumed}" not found locally, restoring conversation from remote...\n`);
  process.stderr.write("Error: Failed to restore session from remote: fetching session record: session get failed: 404 Not Found\n");
  process.exit(1);
}
const session_id = resumed ?? value("--session-id");
const out = (line) => process.stdout.write(JSON.stringify({ ...line, session_id }) + "\n");
const assistant = (content) => out({ type: "assistant", message: { id: "msg_0", type: "message", role: "assistant", model: "grok-4.7", content } });
const toolResult = (id, content, is_error = false) =>
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error }] }, parent_tool_use_id: null });
const result = (subtype, text, extra = {}) =>
  out({
    type: "result",
    subtype,
    is_error: subtype !== "success",
    result: text,
    stop_reason: "end_turn",
    total_cost_usd: 0.04,
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
    modelUsage: { "grok-4.7": { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 500, cacheCreationInputTokens: 0, costUSD: 0.04 } },
    ...extra,
  });

out({ type: "system", subtype: "init", apiKeySource: scenario === "api-key" ? "env" : "oauth", model: value("--model") ?? "grok-4.7", permissionMode: "dontAsk" });
switch (scenario) {
  case "edit":
  case "api-key":
  case "missing-session": {
    assistant([
      { type: "thinking", thinking: "Let me look.", signature: "x" },
      { type: "text", text: "Looking at the project." },
      { type: "tool_use", id: "call-1", name: "run_terminal_command", input: { command: "touch x", description: "make x" } },
    ]);
    toolResult("call-1", '[{"type":"content","content":{"type":"text","text":"Tool `run_terminal_command` was not executed: denied by prompt policy (tool not pre-approved)"}}]', true);
    writeFileSync("grok.txt", "from grok\n");
    assistant([{ type: "tool_use", id: "call-2", name: "write", input: { file_path: join(process.cwd(), "grok.txt"), content: "from grok\n" } }]);
    toolResult("call-2", '{"type":"WriteFile","ok":true}');
    assistant([{ type: "text", text: "Added grok.txt." }]);
    result("success", "Added grok.txt.");
    break;
  }
  case "flow": {
    // Answers as the Navarch profile named at the top of the prompt.
    const prompt = read(value("--prompt-file")) ?? "";
    const profile = /You are the Navarch (\w+) agent/.exec(prompt)?.[1] ?? "unknown";
    if (profile === "implementer") writeFileSync("hello.txt", "hello from fake grok\n");
    const answers = {
      triager: "Kind: feature. Adds one file.\nComplexity: 1",
      planner: "Plan: add hello.txt with a greeting. Acceptance: hello.txt exists.",
      implementer: "Created hello.txt.",
      reviewer: "Verdict: approve. Standards: nothing to report. Spec: matches the plan.",
    };
    assistant([{ type: "text", text: answers[profile] ?? `no answer for ${profile}` }]);
    result("success", answers[profile] ?? `no answer for ${profile}`);
    break;
  }
  case "rate-limit":
    result("error_during_execution", "", { stop_reason: "error", errors: ["rate limit exceeded: too many requests, retry in 30s"], modelUsage: {} });
    process.exit(1);
    break;
  case "free-limit":
    // The real free-tier message carries no reset time.
    result("error_during_execution", "", { stop_reason: "error", errors: ["You've reached your free Grok Build usage limit for now"], modelUsage: {} });
    process.exit(1);
    break;
  case "slow":
    writeFileSync(join(stateDir, "started"), "1");
    await new Promise((r) => setTimeout(r, 60_000));
    break;
}
