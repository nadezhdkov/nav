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
  case "flow": {
    // Answers as the profile named at the top of the prompt; the implementer gets it right only
    // once it is shown the previous verification's failures.
    const profile = /You are the Navarch (\w+) agent/.exec(prompt)?.[1] ?? "unknown";
    if (profile === "implementer") {
      const fixing = prompt.includes('<input name="previous_failures">');
      writeFileSync(fixing ? "hello.txt" : "wrong.txt", "hello from fake claude\n");
      result(true, fixing ? "Fixed: created hello.txt as the check expects." : "Created wrong.txt.");
    } else {
      const answers = {
        triager: "Kind: feature. Complexity 1: one new file.",
        planner: "Plan: add hello.txt with a greeting. Acceptance: hello.txt exists.",
        reviewer: "Verdict: approve. Standards: nothing to report. Spec: matches the plan.",
      };
      result(true, answers[profile] ?? `no answer for ${profile}`);
    }
    break;
  }
  case "lead":
  case "lead-question": {
    // A team lead (ADR 0022): turn 1 delegates to a Codex member (or asks first), a resumed turn
    // finishes once it sees the member's result (or the user's answer).
    const team = (plan) => "```navarch-team\n" + JSON.stringify(plan) + "\n```";
    const profile = /You are the Navarch (\w+) agent/.exec(prompt)?.[1];
    if (resume && prompt.includes("This is your next turn as the team lead")) {
      if (scenario === "lead-question" && !prompt.includes('<input name="team">') && !prompt.includes("<operator_instruction>")) {
        result(true, team({ summary: "Still waiting for an answer.", done: false, question: "Which file name?" }));
      } else if (scenario === "lead-question" && !prompt.includes('<input name="team">')) {
        result(true, "Got the answer.\n" + team({ summary: "Delegating with the answer.", done: false, members: [{ key: "api", title: "Add codex.txt", brief: "Create codex.txt.", profile: "implementer", prefer: "codex" }] }));
      } else {
        result(true, "The member finished.\n" + team({ summary: "Team finished: codex.txt added by the api member.", done: true }));
      }
    } else if (profile === "lead") {
      // The lead uses one sub-agent of its own before planning.
      out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_lead1", name: "Task", input: { description: "Survey the repository" } }] } });
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_lead1", content: "small repo" }] } });
      const plan = scenario === "lead-question"
        ? { summary: "I need to ask first.", done: false, question: "Which file name?" }
        : { summary: "One member adds the file.", done: false, members: [{ key: "api", title: "Add codex.txt", brief: "Create codex.txt.", profile: "implementer", prefer: "codex" }] };
      result(true, "Planning the team.\n" + team(plan));
    } else {
      result(true, profile === "reviewer" ? "Verdict: approve." : `no answer for ${profile}`);
    }
    break;
  }
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
  case "limit-once":
  case "limit-weekly": {
    // Shape of a real rate_limit_event (claude 2.x); the refused window resets soon or in 30 days.
    const marker = join(stateDir, "limited");
    const now = Math.floor(Date.now() / 1000);
    const type = scenario === "limit-once" ? "five_hour" : "seven_day";
    const reset = scenario === "limit-once" ? now + 1 : now + 30 * 86_400;
    if (!existsSync(marker) || scenario === "limit-weekly") {
      writeFileSync(marker, "1");
      const windows = {
        five_hour: { utilization: type === "five_hour" ? 1 : 0.4, resetsAt: type === "five_hour" ? reset : now + 3_600 },
        seven_day: { utilization: type === "seven_day" ? 1 : 0.9, resetsAt: type === "seven_day" ? reset : now + 5 * 86_400 },
      };
      out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: reset, rateLimitType: type, utilization: 1, unifiedWindows: windows } });
      result(false, "You've hit your limit", 0);
      process.exit(1);
    }
    out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: now + 3_600, rateLimitType: "five_hour", utilization: 0.1, unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: now + 3_600 } } } });
    writeFileSync("ok.txt", "ok\n");
    result(true, "Worked after the reset.");
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
