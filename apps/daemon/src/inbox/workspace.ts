import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** `workspace.root` with `~/` expanded, or undefined when the user set none (ADR 0073). */
export function workspaceRoot(configured: string | undefined, home = homedir()): string | undefined {
  if (!configured) return undefined;
  return resolve(configured.startsWith("~/") ? join(home, configured.slice(2)) : configured);
}
