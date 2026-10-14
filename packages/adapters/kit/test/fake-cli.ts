import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, TaskContext } from "@navarch/contracts";

/** Runs a fake CLI script through node; `calls()` returns what each invocation received. */
export function fakeCli(script: string, scenario: string) {
  const stateDir = mkdtempSync(join(tmpdir(), "navarch-fake-"));
  return {
    stateDir,
    options: { command: process.execPath, commandArgs: [script, scenario, stateDir], killGraceMs: 500 },
    calls: (): { args: string[]; cwd: string; prompt?: string; policy?: string }[] => {
      try {
        return readFileSync(join(stateDir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}

export function taskContext(overrides: Partial<TaskContext> = {}): TaskContext {
  const dir = mkdtempSync(join(tmpdir(), "navarch-sbx-"));
  return {
    taskId: "task_1",
    runId: "run_1",
    attempt: 1,
    profile: { id: "implementer", role: "", instructions: "" },
    instructions: "do the task",
    sandbox: { id: "sbx_1", kind: "worktree", path: dir, branch: "navarch/run_1/implement", baseCommit: "abc" },
    tools: { editFiles: true, allowCommands: ["npm test", "npm run *"], denyCommands: ["git push"], denyPaths: ["~/.ssh"], network: false },
    budget: { maxCost: 1, maxTurns: 0, timeoutMs: 10_000 },
    ...overrides,
  };
}

export function collect() {
  const events: AdapterEvent[] = [];
  return { events, io: { emit: (e: AdapterEvent) => events.push(e) } };
}
