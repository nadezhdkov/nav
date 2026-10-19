import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContainerIsolation } from "@navarch/contracts";
import { CONTAINER_ENV } from "./container.ts";

/**
 * L3, the agent in the container (spec §6.5.1, ADR 0069). The agent CLI runs in a throwaway container
 * with no network interface: its only way out is the egress socket (see `egress.ts`), its root is read-only,
 * all capabilities are dropped, and it sees the worktree (read-only for a profile that may not edit), the
 * git directory read-only, a home of its own, and nothing else of the operator's machine.
 */

/** Agents that run in the hardened level; the others keep state in places this does not mount yet. */
export const HARDENED_ADAPTERS = ["claude-code", "codex"] as const;

/** The login of each agent: files under the operator's home, copied into the task's own home. */
const AUTH_FILES: Record<string, string[]> = {
  "claude-code": [".claude/.credentials.json", ".claude.json"],
  codex: [".codex/auth.json"],
};

/** Hosts an agent needs for its model, by adapter; `container.egress_allow` adds to them (🟡 defaults, check them against your account). */
export const DEFAULT_EGRESS: Record<string, string[]> = {
  "claude-code": ["api.anthropic.com", "console.anthropic.com", "claude.ai", "statsig.anthropic.com"],
  codex: ["api.openai.com", "chatgpt.com", "auth.openai.com"],
};

/** Provider keys an agent may be given through the environment; nothing else of the daemon's environment goes in. */
export const FORWARDED_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

/** The proxy the agent finds on the container's own loopback (see `agent-entry.mjs`). */
export const PROXY_URL = "http://127.0.0.1:3128";
export const ENTRY_PATH = fileURLToPath(new URL("./agent-entry.mjs", import.meta.url));

export type AgentContainer = {
  runtime: string;
  /** `isolation.hardened` is set. */
  isolation: ContainerIsolation;
  name: string;
  worktree: string;
  gitDir?: string;
  /** The worktree is mounted read-only (a profile that may not edit files). */
  readOnly: boolean;
  user: { uid: number; gid: number };
  /** The agent's home on the host, mounted at the same path and used as `HOME`. */
  home: string;
  /** Directory holding the egress proxy's socket. */
  socketDir: string;
  socketName: string;
  /** What to run: the host's command name is reduced to its base name, since the image has its own PATH. */
  command: string;
  args: string[];
  /** Provider keys and other variables the agent was given (already filtered). */
  env: Record<string, string>;
};

export function agentContainerArgs(spec: AgentContainer): string[] {
  const { isolation } = spec;
  const hardened = isolation.hardened;
  if (!hardened) throw new Error("not a hardened isolation");
  const mounts = [`--volume=${spec.worktree}:${spec.worktree}:${spec.readOnly ? "ro" : "rw"}`, `--volume=${spec.home}:${spec.home}:rw`, `--volume=${spec.socketDir}:/run/navarch:rw`, `--volume=${ENTRY_PATH}:/opt/navarch/agent-entry.mjs:ro`];
  if (spec.gitDir && !spec.worktree.startsWith(`${spec.gitDir}/`)) mounts.push(`--volume=${spec.gitDir}:${spec.gitDir}:ro`);
  const env: Record<string, string> = {
    ...CONTAINER_ENV,
    NAVARCH_SANDBOX: "hardened",
    ...spec.env,
    HOME: spec.home,
    HTTPS_PROXY: PROXY_URL, HTTP_PROXY: PROXY_URL, ALL_PROXY: PROXY_URL,
    https_proxy: PROXY_URL, http_proxy: PROXY_URL, all_proxy: PROXY_URL,
    NO_PROXY: "", no_proxy: "",
    // Node 24+ honours the proxy variables for fetch only with this.
    NODE_USE_ENV_PROXY: "1",
  };
  const command = isAbsolute(spec.command) ? basename(spec.command) : spec.command;
  return [
    "run", "--rm", "--init", "--interactive", `--name=${spec.name}`, "--pull=missing",
    ...(hardened.oci_runtime ? [`--runtime=${hardened.oci_runtime}`] : []),
    "--network=none",
    `--user=${spec.user.uid}:${spec.user.gid}`,
    "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--read-only", "--tmpfs=/tmp:rw,exec,nosuid,size=1g",
    `--memory=${isolation.memory}`, `--cpus=${isolation.cpus}`, `--pids-limit=${isolation.pids_limit}`,
    ...mounts, `--workdir=${spec.worktree}`,
    ...Object.entries(env).map(([k, v]) => `--env=${k}=${v}`),
    hardened.agent_image,
    "node", "/opt/navarch/agent-entry.mjs", `/run/navarch/${spec.socketName}`, "--", command, ...spec.args,
  ];
}

/** The variables of `env` an agent in a container may have: provider keys only. */
export function forwardedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FORWARDED_ENV) {
    const v = env[key];
    if (v) out[key] = v;
  }
  return out;
}

/** Copies the agent's login from the operator's home into its own; returns what to copy back after the run. */
export function seedHome(adapter: string, operatorHome: string, taskHome: string): { sync(): void } {
  mkdirSync(taskHome, { recursive: true, mode: 0o700 });
  const pairs = (AUTH_FILES[adapter] ?? []).map((rel) => [join(operatorHome, rel), join(taskHome, rel)] as const);
  for (const [from, to] of pairs) {
    if (!existsSync(from)) continue;
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(from, to);
  }
  const before = new Map(pairs.map(([, to]) => [to, existsSync(to) ? statSync(to).mtimeMs : 0]));
  return {
    // A token refreshed inside the container replaces the operator's copy: refresh tokens rotate, so leaving
    // the old file would sign the operator out of their own CLI.
    sync() {
      for (const [from, to] of pairs) {
        if (!existsSync(to) || statSync(to).mtimeMs === before.get(to)) continue;
        try {
          JSON.parse(readFileSync(to, "utf8"));
          copyFileSync(to, from);
        } catch {
          // Not valid JSON: do not overwrite a working login with a damaged file.
        }
      }
    },
  };
}
