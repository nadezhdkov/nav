import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Vitest setup: tests must never reach a real agent CLI, which would spend the operator's quota
 * (a routing test once ran the real `copilot` 10 times). Stubs with the agents' command names go
 * first on PATH and fail loudly; tests use fake CLIs by absolute path instead. Provider keys are
 * removed so the native adapter cannot reach a paid API either.
 */
const AGENT_COMMANDS = ["claude", "gemini", "agy", "codex", "copilot", "opencode", "ollama"];

const dir = mkdtempSync(join(tmpdir(), "navarch-no-agents-"));
for (const name of AGENT_COMMANDS) {
  const stub = join(dir, name);
  writeFileSync(stub, `#!/bin/sh\necho "test tried to run the real ${name} CLI; use a fake CLI" >&2\nexit 127\n`);
  chmodSync(stub, 0o755);
}
process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
for (const key of ["OPENROUTER_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "COPILOT_GITHUB_TOKEN"]) delete process.env[key];
