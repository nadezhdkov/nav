import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeCodeOptions } from "../src/adapter.ts";

export const fakeClaudePath = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

export type FakeScenario = "flow" | "edit" | "slow" | "fail" | "ratelimit-once" | "limit-once" | "limit-weekly" | "secret" | "lead" | "lead-proposals" | "lead-question" | "lead-parallel" | "lead-conflict" | "lead-sublead" | "compete" | "pulls" | "parallel" | "specs";

/** Adapter options that run the fake CLI for a scenario; `stateDir` records each call. */
export function fakeClaude(scenario: FakeScenario): { options: ClaudeCodeOptions; stateDir: string; calls: () => FakeCall[] } {
  const stateDir = mkdtempSync(join(tmpdir(), "navarch-fake-"));
  return {
    stateDir,
    options: { command: process.execPath, commandArgs: [fakeClaudePath, scenario, stateDir], killGraceMs: 500 },
    calls: () => {
      try {
        return readFileSync(join(stateDir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}

export type FakeCall = { args: string[]; cwd: string; prompt: string };

export const fakeClaudeSessionPath = fileURLToPath(new URL("./fixtures/fake-claude-session.mjs", import.meta.url));

/** Adapter options that run the fake interactive CLI of sessions (ADR 0074); `stateDir/session.jsonl` records what it saw. */
export function fakeClaudeSession(): { options: ClaudeCodeOptions; stateDir: string; seen: () => Record<string, unknown>[] } {
  const stateDir = mkdtempSync(join(tmpdir(), "navarch-fake-session-"));
  return {
    stateDir,
    options: { command: process.execPath, commandArgs: [fakeClaudeSessionPath, stateDir], killGraceMs: 500 },
    seen: () => {
      try {
        return readFileSync(join(stateDir, "session.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}
