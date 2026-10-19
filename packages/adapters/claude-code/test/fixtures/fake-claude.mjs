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

// Signed in to a claude.ai plan unless the test wrote another key source into the state dir.
const keySourceFile = join(stateDir, "api-key-source");
const apiKeySource = existsSync(keySourceFile) ? readFileSync(keySourceFile, "utf8").trim() : "none";
out({ type: "system", subtype: "init", session_id: sessionId, model: "fake-model", apiKeySource });

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
  case "lead-proposals":
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
        : { summary: "One member adds the file.", done: false, members: [{ key: "api", title: "Add codex.txt", brief: "Create codex.txt.", profile: "implementer", prefer: "codex", group: "backend" }] };
      result(true, "Planning the team.\n" + team(plan));
    } else {
      // lead-proposals (ADR 0056): the reviewer also suggests two rules, one of which is not one line.
      const proposals = "\n\n```navarch-principles\n" + JSON.stringify({ rules: [{ text: "use Pest, not PHPUnit", reason: "every existing test is a Pest test" }, { text: "two\nlines", reason: "not one line" }] }) + "\n```";
      result(true, profile === "reviewer" ? "Verdict: approve." + (scenario === "lead-proposals" ? proposals : "") : `no answer for ${profile}`);
    }
    break;
  }
  case "lead-parallel":
  case "lead-conflict": {
    // A lead with two independent implementers (ADR 0029). Each member waits until the other has
    // started, so the test sees them overlap; in lead-conflict both write the same file.
    const team = (plan) => "```navarch-team\n" + JSON.stringify(plan) + "\n```";
    const profile = /You are the Navarch (\w+) agent/.exec(prompt)?.[1];
    const conflict = scenario === "lead-conflict";
    if (resume && prompt.includes("This is your next turn as the team lead")) {
      result(true, team({ summary: "Both members are merged.", done: true }));
    } else if (profile === "lead") {
      const members = ["a", "b"].map((key) => ({ key, title: `Member ${key}`, brief: conflict ? `Write shared.txt as ${key}.` : `Create ${key}.txt.`, profile: "implementer" }));
      result(true, team({ summary: "Two members in parallel.", done: false, members }));
    } else if (profile === "implementer" && prompt.includes("conflict markers")) {
      // A demo can hold the resolver to show the team mid-merge.
      while (existsSync(join(stateDir, "hold-resolve"))) await sleep(200);
      writeFileSync("shared.txt", "from a and b\n");
      result(true, "Resolved shared.txt keeping both.");
    } else if (profile === "implementer") {
      const key = /(?:Create|as) (\w)\b/.exec(prompt.split('<input name="brief">')[1] ?? "")?.[1] ?? "x";
      writeFileSync(join(stateDir, `started-${key}`), "");
      const other = key === "a" ? "b" : "a";
      for (let i = 0; i < 100 && !existsSync(join(stateDir, `started-${other}`)); i++) await sleep(50);
      if (existsSync(join(stateDir, `started-${other}`))) writeFileSync(join(stateDir, `overlapped-${key}`), "");
      writeFileSync(conflict ? "shared.txt" : `${key}.txt`, `from ${key}\n`);
      result(true, `Member ${key} done.`);
    } else {
      result(true, profile === "reviewer" ? "Verdict: approve." : `no answer for ${profile}`);
    }
    break;
  }
  case "compete": {
    // Compete mode (ADR 0031): each competitor knows its key from its worktree (…-compete-c<i>).
    // c1 and c2 write answer.txt (the check) and their own file; c3 never passes the check. The
    // judge ranks c2 above c1, and records that it saw both diffs.
    const profile = /You are the Navarch (\w+) agent/.exec(prompt)?.[1];
    if (profile === "implementer") {
      const key = /-compete-(c\d)$/.exec(process.cwd())?.[1] ?? "shared";
      // A run prompt naming "c1 crashes" makes c1's agent fail outright.
      if (key === "c1" && prompt.includes("c1 crashes")) {
        result(false, "c1 crashed", 0);
        process.exit(1);
      }
      if (key === "c3") writeFileSync("wrong.txt", "c3\n");
      else {
        writeFileSync("answer.txt", `${key}\n`);
        writeFileSync(`${key}.txt`, `${key}\n`);
      }
      result(true, `Competitor ${key} done.`);
    } else if (profile === "judge") {
      const saw = ["c1", "c2"].every((k) => prompt.includes(`+${k}`)) ? "both diffs" : "no diffs";
      const ranking = [
        { competitor: "c2", score: 8, reason: "c2 is the smaller change." },
        { competitor: "c1", score: 6, reason: "c1 works too." },
      ];
      result(true, `I read ${saw}.\n\n\`\`\`navarch-judge\n${JSON.stringify({ summary: "c2 wins on size.", ranking })}\n\`\`\``);
    } else {
      result(true, profile === "reviewer" ? "Verdict: approve." : `no answer for ${profile}`);
    }
    break;
  }
  case "pulls": {
    // Runs on pull requests (ADR 0032). The reviewer drafts one comment on a diff line and one
    // outside it; the CI diagnosis says what `ci-kind` in the state dir says (code by default);
    // the implementer fixes the check only when it is given the diagnosis.
    const kind = existsSync(join(stateDir, "ci-kind")) ? readFileSync(join(stateDir, "ci-kind"), "utf8").trim() : "code";
    const saw = [prompt.includes("<pull_request "), prompt.includes("+change"), prompt.includes("hello.txt is missing")].map(Number).join("");
    if (prompt.includes("Navarch pull-request reviewer agent")) {
      const review = { summary: `Reviewed (saw ${saw}). One nit.`, verdict: "approve", comments: [{ path: "pr.txt", line: 1, body: "Say why." }, { path: "README.md", line: 99, body: "Outside the diff." }] };
      result(true, `Done.\n\n\`\`\`navarch-review\n${JSON.stringify(review)}\n\`\`\``);
    } else if (prompt.includes("Navarch CI diagnosis agent")) {
      result(true, `The greeting check fails (saw ${saw}): hello.txt is missing; add it.\n\n\`\`\`navarch-outputs\n${JSON.stringify({ kind })}\n\`\`\``);
    } else if (/You are the Navarch implementer agent/.test(prompt)) {
      if (prompt.includes('<input name="diagnosis">')) writeFileSync("hello.txt", "hello\n");
      result(true, "Added hello.txt as the diagnosis says.");
    } else {
      result(true, "Verdict: approve.");
    }
    break;
  }
  case "specs": {
    // The spec-writer (ADR 0045): the first answer has a broken block, the one after the earlier
    // problems are given is good. One confirmed claim quotes the code, one quotes what is not there.
    if (prompt.includes("Navarch spec-syncer agent")) {
      // The spec-syncer (ADR 0049): a broken block first, then an addendum with one change whose
      // quote is in the code, one removal (no evidence) and a stale claim that does not exist.
      if (!prompt.includes('<input name="previous_failures">')) {
        result(true, "Here is the addendum.\n\n```navarch-addendum\n{ not json\n```");
      } else {
        const addendum = {
          summary: "Login now rate-limits and the plain-text login is gone.",
          changes: [
            { id: "login-rate-limit", component: "auth", kind: "added", text: "login is refused after too many attempts", confidence: "confirmed", evidence: [{ file: "src/auth.ts", line: 3, quote: "checkRateLimit(user)" }] },
            { id: "plain-login-gone", component: "auth", kind: "removed", text: "the plain-text login path no longer exists", confidence: "confirmed", evidence: [] },
          ],
          stale: [
            { component: "auth", claim: "rejects-empty", reason: "empty users now hit the rate limit first" },
            { component: "auth", claim: "does-not-exist", reason: "named by mistake" },
          ],
        };
        result(true, `Done.\n\n\`\`\`navarch-addendum\n${JSON.stringify(addendum)}\n\`\`\``);
      }
    } else if (prompt.includes("Navarch spec-scout agent")) {
      // The spec-scout (ADR 0055): one component and one question for the user.
      result(true, "Components\n- auth: login and sessions, in src/auth.ts\n\nQuestions\n1. Should login lock the account after repeated failures?");
    } else if (!prompt.includes("Navarch spec-writer agent")) {
      result(true, "ok");
    } else if (!prompt.includes('<input name="previous_failures">')) {
      result(true, "Here is the spec.\n\n```navarch-spec\n{ not json\n```");
    } else {
      const spec = {
        component: "auth",
        title: "Authentication",
        summary: "How login works.",
        claims: [
          { id: "rejects-empty", text: "login throws when no user is given", confidence: "confirmed", evidence: [{ file: "src/auth.ts", line: 2, quote: "throw new Error('missing user')" }] },
          { id: "uses-bcrypt", text: "passwords are hashed with bcrypt", confidence: "confirmed", evidence: [{ file: "src/auth.ts", line: 3, quote: "bcrypt.hash(password, 12)" }] },
          { id: "session-ttl", text: "the session lifetime is set elsewhere", confidence: "gap", evidence: [] },
        ],
      };
      result(true, `Done.\n\n\`\`\`navarch-spec\n${JSON.stringify(spec)}\n\`\`\``);
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
  case "parallel": {
    // Parallel branches (ADR 0036): a branch given the input `pace: slow` keeps working until it
    // is stopped; the others answer at once as their profile.
    const profile = /You are the Navarch (\w+) agent/.exec(prompt)?.[1] ?? "unknown";
    if (/<input name="pace">[\s\S]*?slow/.test(prompt)) {
      writeFileSync(join(stateDir, `slow-${process.pid}`), "started");
      out({ type: "assistant", message: { content: [{ type: "text", text: "Taking a long look" }] } });
      await sleep(60_000);
    }
    if (/<input name="pace">[\s\S]*?broken/.test(prompt)) {
      result(false, "the review tool crashed", 0);
      process.exit(1);
    }
    const reviews = (prompt.split('<input name="reviews">')[1] ?? "").split("</input>")[0].trim();
    result(true, reviews ? `Report from: ${reviews.replace(/\s+/g, " ")}` : `${profile} looked at the change.`);
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
