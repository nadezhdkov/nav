import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { scrubbedEnv } from "@navarch/adapter-kit";
import { OpencodeAdapter, opencodePermission, RESUME_PROMPT, type OpencodeOptions } from "@navarch/adapter-opencode";
import type { TaskContext } from "@navarch/contracts";

/**
 * Runs the Kilo CLI headless (`kilo run --format json`). Kilo is a fork of OpenCode: same JSON
 * events, same permission rules, same session ids, so this adapter is the OpenCode adapter with
 * Kilo's flags and environment. Its gateway serves free models (`kilo/kilo-auto/free` and ids
 * ending in `:free`) without an account. The grant becomes `permission` rules in
 * `KILO_CONFIG_CONTENT`; without `--auto`, anything the rules do not allow is refused. The
 * operator's global config (through `XDG_CONFIG_HOME`), project config, Claude Code files and
 * external skills are not loaded. Decision: ADR 0034.
 */

export type KiloOptions = OpencodeOptions;

/** The installer puts the CLI in ~/.kilo/bin, which is often not on PATH. */
export function defaultKiloCommand(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (onPath("kilo", env)) return "kilo";
  const installed = join(home, ".kilo", "bin", "kilo");
  return existsSync(installed) ? installed : "kilo";
}

function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, command)));
}

export class KiloAdapter extends OpencodeAdapter {
  override readonly id: string = "kilo";
  protected override readonly cli: string = "kilo";

  constructor(options: KiloOptions = {}) {
    super({ ...options, command: options.command ?? defaultKiloCommand() });
  }

  /** Free models need no sign-in, so the only thing that can be missing is the CLI itself. */
  unavailableReason(): string | undefined {
    const command = this.options.command;
    const found = command.includes("/") ? existsSync(command) : onPath(command, process.env);
    return found ? undefined : `kilo CLI not found (${command}): install it or set adapters.kilo.command`;
  }

  override buildArgs(ctx: TaskContext, resume?: string): string[] {
    return [
      ...this.options.commandArgs,
      "run",
      "--format",
      "json",
      // No plugins from outside Kilo itself, even if a config somewhere lists them.
      "--pure",
      ...(ctx.model ? ["--model", ctx.model] : []),
      ...(resume ? ["--session", resume] : ["--title", `navarch ${ctx.runId} ${ctx.taskId}`]),
      "--",
      resume ? (ctx.resumePrompt ?? RESUME_PROMPT) : ctx.instructions,
    ];
  }

  override buildEnv(ctx: TaskContext, configDir: string): NodeJS.ProcessEnv {
    const env = scrubbedEnv(this.options.scrubEnv, {
      KILO_CONFIG_CONTENT: JSON.stringify({ permission: opencodePermission(ctx.tools) }),
      // Kilo always reads its global config from $XDG_CONFIG_HOME/kilo: point it at an empty
      // directory. Sessions and a sign-in, if any, stay in the data directory, so resume works.
      XDG_CONFIG_HOME: configDir,
      KILO_CONFIG_DIR: configDir,
      KILO_DISABLE_PROJECT_CONFIG: "1",
      // Kilo also reads ~/.claude (CLAUDE.md, skills) and other agents' skill directories.
      KILO_DISABLE_CLAUDE_CODE: "1",
      KILO_DISABLE_EXTERNAL_SKILLS: "1",
      KILO_DISABLE_AUTOUPDATE: "1",
    });
    for (const name of ["KILO_CONFIG", "KILO_PROVIDER", "KILO_TUI_CONFIG"]) delete env[name];
    return env;
  }
}
