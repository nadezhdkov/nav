import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Vitest setup: tests must never reach a real agent CLI, which would spend the operator's quota
 * (a routing test once ran the real `copilot` 10 times). Stubs with the agents' command names go
 * first on PATH and fail loudly; tests use fake CLIs by absolute path instead. Provider keys are
 * removed so the native adapter cannot reach a paid API either.
 */
/**
 * `secret-tool` too: a test must not read the operator's keychain (provider keys, the GitHub token); `tailscale` reads the operator's tailnet;
 * `docker` and `podman` would pull images and start containers (tests use a fake runtime, the real-Docker test calls it by absolute path).
 */
const AGENT_COMMANDS = ["claude", "gemini", "agy", "codex", "copilot", "opencode", "grok", "ollama", "secret-tool", "tailscale", "docker", "podman"];

const dir = mkdtempSync(join(tmpdir(), "navarch-no-agents-"));
for (const name of AGENT_COMMANDS) {
  const stub = join(dir, name);
  writeFileSync(stub, `#!/bin/sh\necho "test tried to run the real ${name} CLI; use a fake CLI" >&2\nexit 127\n`);
  chmodSync(stub, 0o755);
}
process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
for (const key of ["OPENCODE_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "COPILOT_GITHUB_TOKEN", "XAI_API_KEY"]) delete process.env[key];
// The operator's Grok login must not make the grok adapter routable in tests (ADR 0024).
process.env.GROK_HOME = join(dir, "grok-home");
// git may only reach local repositories: a push, push check or clone aimed at the real GitHub fails at once.
process.env.GIT_ALLOW_PROTOCOL = "file";
