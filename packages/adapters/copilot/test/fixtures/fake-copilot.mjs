#!/usr/bin/env node
// Stand-in for `copilot -p … --output-format json`, used by tests. Event shapes follow a real
// Copilot CLI 1.0.98 run. Usage: fake-copilot.mjs <scenario> <state-dir> [copilot args...]
import { appendFileSync, writeFileSync } from "node:fs";
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
  case "quota":
    out("session.error", { message: "You have exceeded your monthly quota of premium requests." });
    finish(1);
    break;
  case "slow":
    writeFileSync(join(stateDir, "started"), "1");
    await new Promise((r) => setTimeout(r, 60_000));
    break;
}
