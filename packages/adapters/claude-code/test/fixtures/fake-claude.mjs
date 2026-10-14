#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json`, used by tests.
// Usage: fake-claude.mjs <scenario> <state-dir> [claude args...]
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [scenario, stateDir, ...args] = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("9.9.9 (Fake Claude)");
  process.exit(0);
}

const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const resume = flag("--resume");
const sessionId = resume ?? flag("--session-id") ?? "no-session";
const prompt = readFileSync(0, "utf8");
appendFileSync(join(stateDir, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), prompt }) + "\n");

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const result = (ok, text, cost = 0.01, subtype = ok ? "success" : "error_during_execution") =>
  out({
    type: "result",
    subtype,
    is_error: !ok,
    result: text,
    total_cost_usd: cost,
    duration_ms: 5,
    session_id: sessionId,
    permission_denials: scenario === "edit" ? [{ tool_name: "Bash", tool_input: { command: "python3 check.py" } }] : [],
    modelUsage: { "fake-model": { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5, costUSD: cost } },
  });

out({ type: "system", subtype: "init", session_id: sessionId, model: "fake-model" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

switch (scenario) {
  case "edit": {
    out({ type: "assistant", message: { content: [{ type: "text", text: "Creating hello.txt" }] } });
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "hello.txt" } }] } });
    writeFileSync("hello.txt", "hello from fake claude\n");
    result(true, "Created hello.txt with a greeting.");
    break;
  }
  case "slow": {
    if (resume) {
      out({ type: "assistant", message: { content: [{ type: "text", text: "Resuming" }] } });
      writeFileSync("resumed.txt", "resumed\n");
      result(true, "Resumed and finished.");
      break;
    }
    writeFileSync(join(stateDir, "started"), String(process.pid));
    out({ type: "assistant", message: { content: [{ type: "text", text: "Working slowly" }] } });
    writeFileSync("partial.txt", "partial work\n");
    await sleep(60_000);
    result(true, "Finished slowly.");
    break;
  }
  case "fail":
    result(false, "something broke", 0.02);
    process.exit(1);
    break;
  case "ratelimit-once": {
    const marker = join(stateDir, "limited");
    if (!existsSync(marker)) {
      writeFileSync(marker, "1");
      result(false, "API Error: 429 rate limit exceeded", 0);
      process.exit(1);
    }
    writeFileSync("ok.txt", "ok\n");
    result(true, "Worked on the second try.");
    break;
  }
  case "secret":
    out({ type: "assistant", message: { content: [{ type: "text", text: "token ghp_abcdefghijklmnopqrstuvwxyz0123" }] } });
    result(true, "done");
    break;
  default:
    console.error(`unknown scenario ${scenario}`);
    process.exit(2);
}
