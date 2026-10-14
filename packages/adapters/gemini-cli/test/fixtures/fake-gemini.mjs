#!/usr/bin/env node
// Stand-in for `gemini --prompt … --output-format stream-json`, used by tests.
// Usage: fake-gemini.mjs <scenario> <state-dir> [gemini args...]
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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
const policyFile = flag("--policy");
const policy = policyFile ? readFileSync(policyFile, "utf8") : "";
appendFileSync(join(stateDir, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), policy }) + "\n");

const resume = flag("--resume");
const session = resume ?? flag("--session-id") ?? "none";
const ts = new Date().toISOString();
const out = (o) => process.stdout.write(JSON.stringify({ timestamp: ts, ...o }) + "\n");
const stats = { total_tokens: 130, input_tokens: 100, output_tokens: 30, cached: 10, input: 90, duration_ms: 5, tool_calls: 1, models: { "gemini-flash": { total_tokens: 130, input_tokens: 100, output_tokens: 30, cached: 10, input: 90 } } };

if (resume && scenario === "missing-session") {
  console.error(`Invalid session identifier "${resume}".`);
  out({ type: "result", status: "error", error: { type: "Error", message: `Invalid session identifier "${resume}".` }, stats });
  process.exit(1);
}

out({ type: "init", session_id: session, model: "gemini-flash" });
out({ type: "message", role: "user", content: flag("--prompt") });

switch (scenario) {
  case "edit":
  case "missing-session":
    out({ type: "message", role: "assistant", content: "Writing ", delta: true });
    out({ type: "message", role: "assistant", content: "notes.md", delta: true });
    out({ type: "tool_use", tool_name: "write_file", tool_id: "t1", parameters: { file_path: "notes.md", content: "hi" } });
    writeFileSync("notes.md", "hi from gemini\n");
    out({ type: "tool_result", tool_id: "t1", status: "success", output: "ok" });
    out({ type: "tool_use", tool_name: "run_shell_command", tool_id: "t2", parameters: { command: "git push" } });
    out({ type: "tool_result", tool_id: "t2", status: "error", error: { type: "policy_violation", message: "denied by policy" } });
    out({ type: "message", role: "assistant", content: "Created notes.md.", delta: true });
    out({ type: "result", status: "success", stats });
    break;
  case "quota":
    out({ type: "error", severity: "error", message: "Quota exceeded: RESOURCE_EXHAUSTED (429)" });
    out({ type: "result", status: "error", error: { type: "FatalApiError", message: "You exceeded your current quota (429)" }, stats });
    process.exit(1);
    break;
  case "slow":
    writeFileSync(join(stateDir, "started"), "1");
    await new Promise((r) => setTimeout(r, 60_000));
    break;
}
