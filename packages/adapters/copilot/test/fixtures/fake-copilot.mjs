#!/usr/bin/env node
// Stand-in for `copilot -p … --output-format json`, used by tests. Event shapes follow a real
// Copilot CLI 1.0.98 run. Usage: fake-copilot.mjs <scenario> <state-dir> [copilot args...]
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [scenario, stateDir, ...args] = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("GitHub Copilot CLI 0.0.0-fake.");
  process.exit(0);
}
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const prompt = value("-p");
appendFileSync(join(stateDir, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), prompt }) + "\n");
const out = (type, data, extra = {}) => process.stdout.write(JSON.stringify({ type, data, id: "e", timestamp: "t", ...extra }) + "\n");
const resumed = value("--resume");
const sessionId = resumed ?? value("--session-id");
const usageFile = value("--usage-output-file");

if (resumed && scenario === "missing-session") {
  console.error(`Error: Session not found: ${resumed}`);
  process.exit(1);
}

const finish = (exitCode) => {
  if (usageFile) {
    writeFileSync(
      usageFile,
      JSON.stringify({
        totalPremiumRequestCost: 1,
        currentModel: "gpt-6-luna",
        modelMetrics: { "gpt-6-luna": { requests: { count: 3, cost: 1 }, usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 50 } } },
      }),
    );
  }
  process.stdout.write(JSON.stringify({ type: "result", sessionId, exitCode, usage: { premiumRequests: 1 } }) + "\n");
  process.exit(exitCode);
};

out("user.message", { content: prompt });
switch (scenario) {
  case "edit":
  case "missing-session": {
    out("assistant.message", { content: "", toolRequests: [{ toolCallId: "c1", name: "bash" }] });
    out("tool.execution_start", { toolCallId: "c1", toolName: "bash", arguments: { command: "ls && printf hi > x.txt" } });
    out("tool.execution_complete", {
      toolCallId: "c1",
      success: false,
      error: { message: "Permission denied because no interactive user response was available.", code: "denied" },
    });
    out("tool.execution_start", { toolCallId: "c2", toolName: "bash", arguments: { command: "ls", description: "List" } });
    out("tool.execution_complete", { toolCallId: "c2", success: true, shellExecution: { exitCode: 0 }, result: { content: "README.md" } });
    writeFileSync("copilot.txt", "from copilot\n");
    out("tool.execution_start", { toolCallId: "c3", toolName: "apply_patch", arguments: "*** Begin Patch" });
    out("tool.execution_complete", { toolCallId: "c3", success: true, fileEdits: [{ path: resolve("copilot.txt"), kind: "create" }] });
    out("assistant.message", { content: "Added copilot.txt.", toolRequests: [], phase: "final_answer" });
    finish(0);
    break;
  }
  case "flow": {
    // Answers as the Navarch profile named at the top of the prompt.
    const profile = /You are the Navarch (\w+) agent/.exec(prompt)?.[1] ?? "unknown";
    if (profile === "implementer") writeFileSync("hello.txt", "hello from fake copilot\n");
    const answers = {
      triager: "Kind: feature. Adds one file.\nComplexity: 1",
      planner: "Plan: add hello.txt with a greeting. Acceptance: hello.txt exists.",
      implementer: "Created hello.txt.",
      reviewer: "Verdict: approve. Standards: nothing to report. Spec: matches the plan.",
    };
    out("assistant.message", { content: answers[profile] ?? `no answer for ${profile}`, toolRequests: [] });
    finish(0);
    break;
  }
  case "hook": {
    // Loads the --plugin-dir plugin as Copilot does and asks its permissionRequest hook about two commands.
    const dir = value("--plugin-dir");
    const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
    const [entry] = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")).hooks.permissionRequest;
    const ask = (command) => {
      const event = { hookName: "permissionRequest", sessionId, cwd: process.cwd(), toolName: "bash", toolInput: { command }, permissionSuggestions: [] };
      const r = spawnSync("sh", ["-c", entry.bash], { input: JSON.stringify(event), encoding: "utf8" });
      return { status: r.status, output: JSON.parse(r.stdout || "{}") };
    };
    const answers = { "make lint": ask("make lint"), "make deploy": ask("make deploy") };
    writeFileSync(join(stateDir, "hook.json"), JSON.stringify({ dir, manifest, entry, answers }));
    out("assistant.message", { content: "Asked the hook.", toolRequests: [] });
    finish(0);
    break;
  }
  case "quota":
    out("session.error", { message: "You have exceeded your monthly quota of premium requests." });
    finish(1);
    break;
  case "slow":
    writeFileSync(join(stateDir, "started"), "1");
    await new Promise((r) => setTimeout(r, 60_000));
    break;
}
