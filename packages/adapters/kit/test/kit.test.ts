import { describe, expect, it } from "vitest";
import { classifyError, commandAllowed, matchesPattern } from "../src/index.ts";

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
