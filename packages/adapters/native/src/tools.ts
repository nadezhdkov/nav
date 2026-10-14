import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { commandAllowed, scrubbedEnv } from "@navarch/adapter-kit";
import type { ToolGrant } from "@navarch/contracts";

/**
 * Tools the native agent can call. Navarch executes every call itself, so each one is checked
 * here: paths must resolve inside the sandbox (symlinks included), `.git` is read-only, and
 * commands must match the grant's allowlist with no shell syntax.
 */

export type ToolSpec = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const s = (description: string) => ({ type: "string", description });
const n = (description: string) => ({ type: "integer", description });

export function toolSpecs(grant: ToolGrant): ToolSpec[] {
  const specs: ToolSpec[] = [
    fn("list_files", "List tracked and untracked files under a directory (relative to the repository root).", obj({ path: s("Directory, default '.'") }, [])),
    fn("read_file", "Read a text file. Returns numbered lines; use start_line/end_line for large files.", obj({ path: s("File path"), start_line: n("First line, 1-based"), end_line: n("Last line, inclusive") }, ["path"])),
    fn("search", "Search file contents with a regular expression (git grep). Returns file:line:text matches.", obj({ pattern: s("Regular expression"), path: s("Limit to this directory or file") }, ["pattern"])),
  ];
  if (grant.editFiles) {
    specs.push(
      fn("write_file", "Create or overwrite a file with the given content.", obj({ path: s("File path"), content: s("Full file content") }, ["path", "content"])),
      fn("edit_file", "Replace one exact occurrence of old_text with new_text in a file.", obj({ path: s("File path"), old_text: s("Exact text to replace (must occur once)"), new_text: s("Replacement text") }, ["path", "old_text", "new_text"])),
    );
  }
  if (grant.allowCommands.length) {
    specs.push(
      fn(
        "run_command",
        `Run one allowed shell command in the repository root. Allowed: ${grant.allowCommands.join(", ")}. No pipes, redirects or chaining.`,
        obj({ command: s("The command line") }, ["command"]),
      ),
    );
  }
  return specs;
}

function fn(name: string, description: string, parameters: Record<string, unknown>): ToolSpec {
  return { type: "function", function: { name, description, parameters } };
}

export type ToolOutcome = { output: string; denied?: { tool: string; input: string } };

const MAX_OUTPUT = 20_000;
const MAX_LINES = 400;

export class SandboxTools {
  private readonly root: string;
  private readonly grant: ToolGrant;

  constructor(root: string, grant: ToolGrant) {
    this.root = realpathSync(root);
    this.grant = grant;
  }

  async call(name: string, rawArgs: string): Promise<ToolOutcome> {
    let args: Record<string, unknown>;
    try {
      args = rawArgs.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      return { output: `error: arguments are not valid JSON: ${rawArgs.slice(0, 200)}` };
    }
    const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
    const int = (k: string) => (typeof args[k] === "number" ? Math.trunc(args[k] as number) : undefined);
    try {
      switch (name) {
        case "list_files":
          return { output: await this.listFiles(str("path") || ".") };
        case "read_file":
          return { output: await this.readFile(str("path"), int("start_line"), int("end_line")) };
        case "search":
          return { output: await this.search(str("pattern"), str("path")) };
        case "write_file":
          if (!this.grant.editFiles) return deny(name, str("path"), "file edits are not granted");
          return { output: await this.writeFile(str("path"), str("content")) };
        case "edit_file":
          if (!this.grant.editFiles) return deny(name, str("path"), "file edits are not granted");
          return { output: await this.editFile(str("path"), str("old_text"), str("new_text")) };
        case "run_command":
          return await this.runCommand(str("command"));
        default:
          return { output: `error: unknown tool ${name}` };
      }
    } catch (err) {
      if (err instanceof SandboxViolation) return deny(name, err.path, err.message);
      return { output: `error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** Resolves a path inside the sandbox; throws if it (or a symlink on the way) escapes. */
  resolvePath(path: string, forWrite = false): string {
    if (!path) throw new Error("path is required");
    const target = resolve(this.root, path);
    if (!within(this.root, target)) throw new SandboxViolation(path, "path is outside the worktree");
    let existing = target;
    while (!existsSync(existing)) existing = dirname(existing);
    if (!within(this.root, realpathSync(existing))) throw new SandboxViolation(path, "path resolves outside the worktree");
    const rel = relative(this.root, target);
    if (forWrite && (rel === ".git" || rel.startsWith(`.git${sep}`))) {
      throw new SandboxViolation(path, ".git is read-only");
    }
    return target;
  }

  private async listFiles(path: string): Promise<string> {
    const dir = this.resolvePath(path);
    const out = await run("git", ["ls-files", "-co", "--exclude-standard", "--", relative(this.root, dir) || "."], this.root);
    const files = out.stdout.split("\n").filter(Boolean);
    const shown = files.slice(0, 500);
    return shown.join("\n") + (files.length > shown.length ? `\n… ${files.length - shown.length} more` : "") || "(no files)";
  }

  private async readFile(path: string, start?: number, end?: number): Promise<string> {
    const file = this.resolvePath(path);
    const lines = (await readFile(file, "utf8")).split("\n");
    const from = Math.max(1, start ?? 1);
    const to = Math.min(lines.length, end ?? from + MAX_LINES - 1, from + MAX_LINES - 1);
    const body = lines
      .slice(from - 1, to)
      .map((line, i) => `${from + i}\t${line}`)
      .join("\n");
    return to < lines.length ? `${body}\n… file has ${lines.length} lines; read more with start_line=${to + 1}` : body;
  }

  private async search(pattern: string, path: string): Promise<string> {
    if (!pattern) return "error: pattern is required";
    const scope = path ? relative(this.root, this.resolvePath(path)) || "." : ".";
    const out = await run("git", ["grep", "-n", "-I", "--untracked", "-E", "-e", pattern, "--", scope], this.root);
    if (out.code === 1) return "(no matches)";
    if (out.code !== 0) return `error: ${out.stderr.trim()}`;
    return cap(out.stdout);
  }

  private async writeFile(path: string, content: string): Promise<string> {
    const file = this.resolvePath(path, true);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    return `wrote ${relative(this.root, file)} (${content.split("\n").length} lines)`;
  }

  private async editFile(path: string, oldText: string, newText: string): Promise<string> {
    const file = this.resolvePath(path, true);
    const content = await readFile(file, "utf8");
    if (!oldText) return "error: old_text is required";
    const count = content.split(oldText).length - 1;
    if (count !== 1) return `error: old_text occurs ${count} times; it must occur exactly once`;
    await writeFile(file, content.replace(oldText, () => newText));
    return `edited ${relative(this.root, file)}`;
  }

  private async runCommand(command: string): Promise<ToolOutcome> {
    if (!commandAllowed(command, this.grant.allowCommands, this.grant.denyCommands)) {
      return deny("run_command", command, "command is not in the allowlist");
    }
    const [bin, ...args] = splitCommand(command);
    if (!bin) return { output: "error: empty command" };
    const out = await run(bin, args, this.root, 120_000);
    return { output: cap(`exit ${out.code}\n${out.stdout}${out.stderr ? `\n[stderr]\n${out.stderr}` : ""}`) };
  }
}

class SandboxViolation extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

function deny(tool: string, input: string, reason: string): ToolOutcome {
  return { output: `denied: ${reason}`, denied: { tool, input: `${tool} ${input}`.slice(0, 300) } };
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function cap(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… output truncated` : text;
}

/** Splits a command line on whitespace, honouring simple single and double quotes. */
export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || current) parts.push(current);
      current = "";
      has = false;
    } else {
      current += ch;
      has = true;
    }
  }
  if (has || current) parts.push(current);
  return parts;
}

function run(
  bin: string,
  args: string[],
  cwd: string,
  timeout = 30_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    if (isAbsolute(bin) && !existsSync(bin)) {
      done({ code: 127, stdout: "", stderr: `${bin}: not found` });
      return;
    }
    execFile(bin, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, env: scrubbedEnv() }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) || (err && code !== 1 ? err.message : "") });
    });
  });
}
