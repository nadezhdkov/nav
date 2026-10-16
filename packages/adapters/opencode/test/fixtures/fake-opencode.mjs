#!/usr/bin/env node
// Stand-in for `opencode run --format json`, used by tests. Event shapes follow a real
// OpenCode 2.0.29 run. Usage: fake-opencode.mjs <scenario> <state-dir> [opencode args...]
import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [scenario, stateDir, ...args] = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.0.0-fake");
  process.exit(0);
}
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const prompt = args[args.indexOf("--") + 1];
const env = {
  config: process.env.OPENCODE_CONFIG_CONTENT,
  configDir: process.env.OPENCODE_CONFIG_DIR,
  noProject: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
  operatorConfig: process.env.OPENCODE_CONFIG,
  githubToken: process.env.GITHUB_TOKEN,
  pwd: process.env.PWD,
};
appendFileSync(join(stateDir, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), prompt, env }) + "\n");

const resumed = value("--session");
const sessionID = resumed ?? "ses_fake0001";
const out = (type, rest = {}) => process.stdout.write(JSON.stringify({ type, timestamp: 1, sessionID, ...rest }) + "\n");
const tool = (name, status, input, extra = {}) =>
  out("tool_use", { part: { type: "tool", tool: name, state: { status, input, ...extra } } });
const step = (tokens = { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 0 } }) =>
  out("step_finish", { part: { type: "step-finish", reason: "stop", cost: 0, tokens } });

if (resumed && scenario === "foreign-session") {
  out("step_start", { part: { type: "step-start" } });
  out("error", { error: { type: "provider.auth", message: "OpenCode's free tier can only be used from within OpenCode.", status: 403 } });
  process.exit(1);
}

out("step_start", { part: { type: "step-start" } });
switch (scenario) {
  case "edit":
  case "foreign-session": {
    out("text", { part: { type: "text", text: "Let me look first.</think>Looking." } });
    tool("shell", "error", { command: "ls && touch x" }, { error: "Permission denied: shell" });
    tool("shell", "completed", { command: "ls" }, { output: "README.md\n" });
    writeFileSync("opencode.txt", "from opencode\n");
    tool("write", "completed", { path: resolve("opencode.txt"), content: "from opencode\n" }, { output: "Created file" });
    step();
    out("step_start", { part: { type: "step-start" } });
    out("text", { part: { type: "text", text: "Added opencode.txt." } });
    step({ input: 200, output: 20, reasoning: 0, cache: { read: 100, write: 0 } });
    process.exit(0);
    break;
  }
  case "flow": {
    // Answers as the Navarch profile named at the top of the prompt.
    const profile = /You are the Navarch (\w+) agent/.exec(prompt)?.[1] ?? "unknown";
    if (profile === "implementer") writeFileSync("hello.txt", "hello from fake opencode\n");
    const answers = {
      triager: "Kind: feature. Adds one file.\nComplexity: 1",
      planner: "Plan: add hello.txt with a greeting. Acceptance: hello.txt exists.",
      implementer: "Created hello.txt.",
      reviewer: "Verdict: approve. Standards: nothing to report. Spec: matches the plan.",
    };
    out("text", { part: { type: "text", text: answers[profile] ?? `no answer for ${profile}` } });
    step();
    process.exit(0);
    break;
  }
  case "rate-limit":
    out("error", { error: { type: "provider.rate-limit", message: "Rate limit exceeded, retry in 30s", status: 429 } });
    process.exit(1);
    break;
  case "expensive":
    // Metered steps of $0.30 each, then a long wait: only a cap stops it.
    for (let i = 0; i < 5; i++) {
      out("step_finish", { part: { type: "step-finish", reason: "tool-calls", cost: 0.3, tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } } });
      out("step_start", { part: { type: "step-start" } });
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 60_000));
    break;
  case "slow":
    writeFileSync(join(stateDir, "started"), "1");
    await new Promise((r) => setTimeout(r, 60_000));
    break;
}
