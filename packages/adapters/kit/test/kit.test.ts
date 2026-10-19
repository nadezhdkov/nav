import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliProcesses, classifyError, cliOutcome, commandAllowed, epochToIso, matchesPattern, retryAtFromText, scrubbedEnv } from "../src/index.ts";

describe("command patterns", () => {
  it("matches exact commands and prefix wildcards on word boundaries", () => {
    expect(matchesPattern("npm test", "npm test")).toBe(true);
    expect(matchesPattern("npm test --watch", "npm test")).toBe(false);
    expect(matchesPattern("npm run lint", "npm run *")).toBe(true);
    expect(matchesPattern("npm runner", "npm run *")).toBe(false);
  });

  it("rejects denied prefixes and shell syntax even when an allow pattern matches", () => {
    expect(commandAllowed("git push origin main", ["git *"], ["git push"])).toBe(false);
    expect(commandAllowed("npm test && rm -rf /", ["npm test *"], [])).toBe(false);
    expect(commandAllowed("npm test | tee out", ["npm test *"], [])).toBe(false);
    expect(commandAllowed("echo $HOME", ["echo *"], [])).toBe(false);
    expect(commandAllowed("git commit -m 'fix: x'", ["git commit *"], ["git push"])).toBe(true);
  });
});

describe("classifyError", () => {
  it("maps provider messages to retry classes", () => {
    expect(classifyError("429 Too Many Requests")).toBe("rate_limited");
    expect(classifyError("RESOURCE_EXHAUSTED: quota")).toBe("rate_limited");
    expect(classifyError("socket hang up")).toBe("transient");
    expect(classifyError("max budget reached")).toBe("budget_exceeded");
    expect(classifyError("invalid argument")).toBe("fatal");
  });
});

describe("retryAtFromText", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();

  it("reads the reset hints providers put in rate-limit messages", () => {
    expect(retryAtFromText("Quota exceeded. Please retry in 23.5s.", now)).toBe(at(23_500));
    expect(retryAtFromText('{"@type":"RetryInfo","retryDelay": "41s"}', now)).toBe(at(41_000));
    expect(retryAtFromText("Weekly limit reached. Refreshes in 167h 2m", now)).toBe(at(167 * 3_600_000 + 2 * 60_000));
    expect(retryAtFromText("rate limited, try again in 5 minutes", now)).toBe(at(300_000));
    expect(retryAtFromText("usage limit reached; resets in 1h30m", now)).toBe(at(5_400_000));
  });

  it("reads the other ways a duration is written", () => {
    expect(retryAtFromText("Try Again After 2 Hours and 5 minutes, please", now)).toBe(at(2 * 3_600_000 + 5 * 60_000));
    expect(retryAtFromText("available again in 1 day, 2 hrs", now)).toBe(at(86_400_000 + 2 * 3_600_000));
    expect(retryAtFromText("retry in 0.5 secs", now)).toBe(at(500));
    // The first hint that has a duration wins; an earlier phrase without one is skipped.
    expect(retryAtFromText("Please retry. It resets in 3m; retry in 9s", now)).toBe(at(180_000));
  });

  it("returns undefined without a hint", () => {
    expect(retryAtFromText("You exceeded your current quota (429)", now)).toBeUndefined();
    expect(retryAtFromText("retry in a while", now)).toBeUndefined();
    expect(retryAtFromText("retry info 5s", now)).toBeUndefined();
    expect(retryAtFromText("retry in 5 msec", now)).toBeUndefined();
    expect(retryAtFromText("retry in 0s", now)).toBeUndefined();
  });

  it("returns undefined, rather than throwing, for a time too far away to be a date", () => {
    expect(retryAtFromText("retry in 9999999999 days", now)).toBeUndefined();
    expect(retryAtFromText('"retryDelay": "99999999999999999s"', now)).toBeUndefined();
  });

  it("reads long runs of spaces, digits and commas in time proportional to their length", () => {
    const long = 200_000;
    const started = performance.now();
    for (const text of [
      "retry in" + " ".repeat(long) + "x",
      "retry in " + "1 ".repeat(long) + "s",
      "retry in 1s" + ", ".repeat(long) + "x",
      "retry in 1s " + "and ".repeat(long) + "x",
      "retry in ".repeat(long / 10) + "x",
    ]) retryAtFromText(text, now);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("converts epoch seconds and milliseconds", () => {
    expect(epochToIso(1792400400)).toBe("2026-10-19T09:00:00.000Z");
    expect(epochToIso(1792400400000)).toBe("2026-10-19T09:00:00.000Z");
  });
});

describe("cliOutcome", () => {
  const exit = { code: 1, signal: null, stderr: "", cancelled: false, timedOut: false };

  it("adds the reset time to a rate-limited failure", () => {
    const result = cliOutcome("gemini", exit, { ok: false, error: "429 RESOURCE_EXHAUSTED. Please retry in 30s.", summary: "", usage: [] }, "");
    expect(result.error?.kind).toBe("rate_limited");
    expect(Date.parse(result.error!.retry_at!)).toBeGreaterThan(Date.now() + 25_000);
  });

  it("leaves other failures alone", () => {
    const result = cliOutcome("gemini", exit, { ok: false, error: "boom, retry in 30s", summary: "", usage: [] }, "");
    expect(result.error).toEqual({ kind: "fatal", message: "boom, retry in 30s" });
  });
});

describe("scrubbedEnv", () => {
  it("never passes NAVARCH_SECRET_*, the legacy VECTR_SECRET_* or the listed tokens to agents and commands", () => {
    process.env.NAVARCH_SECRET_GITHUB_TOKEN = "github_pat_must_not_leak_123";
    process.env.NAVARCH_SECRET_ANTHROPIC_API_KEY = "sk-must-not-leak";
    process.env.GH_TOKEN = "gho_must_not_leak";
    process.env.VECTR_SECRET_GITHUB_TOKEN = "github_pat_legacy_must_not_leak";
    try {
      const env = scrubbedEnv();
      expect(Object.keys(env).filter((k) => /^(NAVARCH|VECTR)_SECRET_/.test(k) || k === "GH_TOKEN")).toEqual([]);
      expect(scrubbedEnv([], { NAVARCH_SECRET_X: "y" }).NAVARCH_SECRET_X).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.NAVARCH_SECRET_GITHUB_TOKEN;
      delete process.env.NAVARCH_SECRET_ANTHROPIC_API_KEY;
      delete process.env.GH_TOKEN;
      delete process.env.VECTR_SECRET_GITHUB_TOKEN;
    }
  });
});

describe("CliProcesses", () => {
  // OpenCode picks its project from $PWD, not the process cwd: an inherited PWD made agents work
  // in the daemon's directory instead of their worktree (ADR 0015).
  it("sets PWD to the working directory, whatever the environment says", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "navarch-cwd-")));
    const lines: string[] = [];
    await new CliProcesses().run({
      taskId: "t",
      command: process.execPath,
      args: ["-e", "console.log(process.env.PWD)"],
      cwd,
      env: { ...process.env, PWD: "/somewhere/else" },
      timeoutMs: 10_000,
      onLine: (l) => lines.push(l),
    });
    expect(lines).toEqual([cwd]);
  });
});
