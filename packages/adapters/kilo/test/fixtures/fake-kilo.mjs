#!/usr/bin/env node
// Stand-in for `kilo run --format json`, used by tests. Event shapes follow a real Kilo CLI
// 7.8.12 run. Usage: fake-kilo.mjs <scenario> <state-dir> [kilo args...]
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
  config: process.env.KILO_CONFIG_CONTENT,
  configDir: process.env.KILO_CONFIG_DIR,
  xdgConfig: process.env.XDG_CONFIG_HOME,
  noProject: process.env.KILO_DISABLE_PROJECT_CONFIG,
  noClaude: process.env.KILO_DISABLE_CLAUDE_CODE,
  noSkills: process.env.KILO_DISABLE_EXTERNAL_SKILLS,
  operatorConfig: process.env.KILO_CONFIG,
  provider: process.env.KILO_PROVIDER,
  githubToken: process.env.GITHUB_TOKEN,
  pwd: process.env.PWD,
};
appendFileSync(join(stateDir, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), prompt, env }) + "\n");

const resumed = value("--session");
if (resumed && scenario === "missing-session") {
  process.stderr.write("\u001b[91m\u001b[1mError: \u001b[0mSession not found\n");
  process.exit(1);
}
const sessionID = resumed ?? "ses_kilo0001";
const out = (type, rest = {}) => process.stdout.write(JSON.stringify({ type, timestamp: 1, sessionID, ...rest }) + "\n");
const tool = (name, status, input, extra = {}) =>
  out("tool_use", { part: { type: "tool", tool: name, state: { status, input, ...extra } } });
const step = (tokens = { total: 0, input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 0 } }) =>
  out("step_finish", { part: { type: "step-finish", reason: "stop", model: { providerID: "kilo", modelID: "dots-studio/dots-3-note-preview:free" }, cost: 0, tokens } });
const denied = (pattern) =>
  `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules {"permission":"bash","pattern":"${pattern}","action":"deny"}`;

out("step_start", { part: { type: "step-start" } });
switch (scenario) {
  case "edit":
  case "missing-session": {
    out("text", { part: { type: "text", text: "\n\nLooking." } });
    tool("bash", "error", { command: "ls > list.txt" }, { error: denied("*>*") });
    tool("write", "error", { filePath: resolve("x.txt") }, { error: "Model tried to call unavailable tool 'write'. Available tools: bash, glob, grep, read." });
    tool("bash", "completed", { command: "ls" }, { output: "README.md\n" });
    writeFileSync("kilo.txt", "from kilo\n");
    tool("edit", "completed", { filePath: resolve("kilo.txt") }, { output: "Edit applied" });
    step();
    out("step_start", { part: { type: "step-start" } });
    out("text", { part: { type: "text", text: "Added kilo.txt." } });
    step({ total: 0, input: 200, output: 20, reasoning: 0, cache: { read: 100, write: 0 } });
    process.exit(0);
    break;
  }
  case "flow": {
    // Answers as the Navarch profile named at the top of the prompt.
    const profile = /You are the Navarch (\w+) agent/.exec(prompt)?.[1] ?? "unknown";
    if (profile === "implementer") writeFileSync("hello.txt", "hello from fake kilo\n");
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
  case "unknown-model":
    out("error", { error: { name: "UnknownError", data: { message: "Unexpected server error. Check server logs for details.", ref: "err_1" } } });
    out("error", { error: { name: "UnknownError", data: { message: "Model not found: kilo/nope/none." } } });
    process.stderr.write("Error: Model not found: kilo/nope/none.\n");
    process.exit(1);
    break;
  case "rate-limit":
    out("error", { error: { name: "APIError", data: { message: "Rate limit exceeded, retry in 30s", statusCode: 429 } } });
    process.exit(1);
    break;
  case "slow":
    writeFileSync(join(stateDir, "started"), "1");
    await new Promise((r) => setTimeout(r, 60_000));
    break;
}
