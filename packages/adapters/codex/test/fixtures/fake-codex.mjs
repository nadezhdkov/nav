#!/usr/bin/env node
// Stand-in for `codex exec --json`, used by tests.
// Usage: fake-codex.mjs <scenario> <state-dir> [codex args...]
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [scenario, stateDir, ...args] = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.0.0-fake");
  process.exit(0);
}
const prompt = readFileSync(0, "utf8");
appendFileSync(join(stateDir, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), prompt }) + "\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const resumeIndex = args.indexOf("resume");
const resumed = resumeIndex >= 0 ? args[args.length - 2] : undefined;

if (resumed && scenario === "missing-session") {
  console.error(`Error: no rollout found for thread id ${resumed}`);
  process.exit(1);
}

out({ type: "thread.started", thread_id: resumed ?? "019a-fake-thread" });
out({ type: "turn.started" });

switch (scenario) {
  case "edit":
  case "missing-session":
    out({ type: "item.completed", item: { id: "i0", type: "reasoning", text: "thinking" } });
    out({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "bash -lc ls", aggregated_output: "README.md", exit_code: 0, status: "completed" } });
    writeFileSync("codex.txt", "from codex\n");
    out({ type: "item.completed", item: { id: "i2", type: "file_change", changes: [{ path: "codex.txt", kind: "add" }], status: "completed" } });
    out({ type: "item.completed", item: { id: "i3", type: "agent_message", text: "Added codex.txt." } });
    out({ type: "turn.completed", usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 40 } });
    break;
  case "fail":
    out({ type: "error", message: "stream disconnected: 429 Too Many Requests" });
    out({ type: "turn.failed", error: { message: "429 Too Many Requests" } });
    process.exit(1);
    break;
  case "slow":
    writeFileSync(join(stateDir, "started"), "1");
    await new Promise((r) => setTimeout(r, 60_000));
    break;
}
