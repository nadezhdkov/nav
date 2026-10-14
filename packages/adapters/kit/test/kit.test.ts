import { describe, expect, it } from "vitest";
import { classifyError, cliOutcome, commandAllowed, epochToIso, matchesPattern, retryAtFromText, scrubbedEnv } from "../src/index.ts";

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

  it("returns undefined without a hint", () => {
    expect(retryAtFromText("You exceeded your current quota (429)", now)).toBeUndefined();
    expect(retryAtFromText("retry in a while", now)).toBeUndefined();
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
  it("never passes VECTR_SECRET_* or the listed tokens to agents and commands", () => {
    process.env.VECTR_SECRET_GITHUB_TOKEN = "github_pat_must_not_leak_123";
    process.env.VECTR_SECRET_ANTHROPIC_API_KEY = "sk-must-not-leak";
    process.env.GH_TOKEN = "gho_must_not_leak";
    try {
      const env = scrubbedEnv();
      expect(Object.keys(env).filter((k) => k.startsWith("VECTR_SECRET_") || k === "GH_TOKEN")).toEqual([]);
      expect(scrubbedEnv([], { VECTR_SECRET_X: "y" }).VECTR_SECRET_X).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.VECTR_SECRET_GITHUB_TOKEN;
      delete process.env.VECTR_SECRET_ANTHROPIC_API_KEY;
      delete process.env.GH_TOKEN;
    }
  });
});
