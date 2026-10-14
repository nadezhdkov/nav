#!/usr/bin/env node
// Stand-in for `agy --print … --output-format stream-json`, used by tests. Events mirror agy 1.3.5.
// Usage: fake-agy.mjs <scenario> <state-dir> [agy args...]
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [scenario, stateDir, ...args] = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.0.0-fake");
  process.exit(0);
}
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const home = process.env.HOME;
const cliDir = join(home, ".gemini", "antigravity-cli");
const settingsFile = join(cliDir, "settings.json");
const settings = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : "";
appendFileSync(join(stateDir, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), prompt: flag("--print"), policy: settings, home }) + "\n");

const conversation = flag("--conversation") ?? `conv-${Date.now()}`;
mkdirSync(join(cliDir, "conversations"), { recursive: true });
writeFileSync(join(cliDir, "conversations", `${conversation}.db`), "");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const step = (o) => out({ event: "step_update", step_update: { conversation_id: conversation, ...o } });
// Like agy, usage is cumulative for the conversation: each call adds one turn's worth.
const turns = readFileSync(join(stateDir, "calls.jsonl"), "utf8").trim().split("\n").length;
const usage = { input_tokens: 100 * turns, output_tokens: 20 * turns, thinking_tokens: 10 * turns, cache_read_tokens: 5 * turns, total_tokens: 135 * turns };
const result = (o) => out({ event: "result", result: { conversation_id: conversation, duration_seconds: 1, num_turns: 1, usage, ...o } });

if (scenario === "bad-model") {
  result({ conversation_id: "", status: "ERROR", response: "", error: 'invalid model selection (--model "nope")' });
  console.error('error: invalid model selection (--model "nope")');
  process.exit(1);
}

out({ event: "init", conversation_id: conversation, init: { model: flag("--model") ?? "gemini-3.8-flash-medium", cwd: process.cwd(), tools: ["run_command"] } });
step({ step_index: 0, state: "DONE", step_type: "user_input" });

switch (scenario) {
  case "edit": {
    const write = { name: "write_to_file", parameters: { TargetFile: join(process.cwd(), "notes.md") } };
    step({ step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: write });
    writeFileSync("notes.md", "hi from agy\n");
    step({ step_index: 1, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: write });
    step({ step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "Created " });
    step({ step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "notes.md." });
    result({ status: "SUCCESS", response: "Created notes.md.\n" });
    break;
  }
  case "denied":
  case "always-denied": {
    if (scenario === "denied" && flag("--conversation")) {
      step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Done without pushing." });
      result({ status: "SUCCESS", response: "Done without pushing." });
      break;
    }
    const push = { name: "run_command", parameters: { CommandLine: "git push origin main" } };
    step({ step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: push });
    step({ step_index: 1, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: push });
    console.error('jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.');
    result({ status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "RunCommand" }] });
    break;
  }
  case "resume":
    step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Continued." });
    result({ status: "SUCCESS", response: "Continued." });
    break;
  case "quota":
    result({ status: "ERROR", response: "", error: "RESOURCE_EXHAUSTED: quota exceeded for this account (429)" });
    process.exit(1);
    break;
  case "slow":
    writeFileSync(join(stateDir, "started"), "1");
    await new Promise((r) => setTimeout(r, 60_000));
    break;
}
