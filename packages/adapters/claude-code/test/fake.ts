import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeCodeOptions } from "../src/adapter.ts";

export const fakeClaudePath = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

export type FakeScenario = "edit" | "slow" | "fail" | "ratelimit-once" | "secret";

/** Adapter options that run the fake CLI for a scenario; `stateDir` records each call. */
export function fakeClaude(scenario: FakeScenario): { options: ClaudeCodeOptions; stateDir: string; calls: () => FakeCall[] } {
  const stateDir = mkdtempSync(join(tmpdir(), "vectr-fake-"));
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
