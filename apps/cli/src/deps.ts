import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Whether this checkout's installed dependencies still match its lockfile. A `git pull` that adds a
 * package leaves `node_modules` behind, and the daemon then fails to start on a missing import
 * (go/no-go finding F3). pnpm keeps a copy of the lockfile it installed in `node_modules/.pnpm/lock.yaml`;
 * `pnpm-lock.yaml` may start with other YAML documents (pnpm's own version), so its last one is compared.
 */
export function installProblem(root: string): string | undefined {
  const lock = join(root, "pnpm-lock.yaml");
  if (!existsSync(lock)) return undefined;
  const installed = join(root, "node_modules", ".pnpm", "lock.yaml");
  if (!existsSync(installed)) return `dependencies are not installed in ${root}: run \`make install\``;
  const wanted = readFileSync(lock, "utf8").split(/\n---\n/).at(-1)!;
  if (wanted !== readFileSync(installed, "utf8")) return `dependencies in ${root} are older than pnpm-lock.yaml: run \`make install\``;
  return undefined;
}

/** The checkout around `file`: the nearest directory above it with a `pnpm-lock.yaml`. */
export function checkoutRoot(file: string): string | undefined {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-lock.yaml"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/** What to tell the user when the daemon's log shows it died on a missing package. */
export function startFailureHint(log: string): string | undefined {
  const m = /Cannot find (?:package|module) '(@navarch\/[^'/]+)/.exec(log) ?? /ERR_MODULE_NOT_FOUND[^\n]*'(@navarch\/[^'/]+)/.exec(log);
  return m ? `${m[1]} is missing: the dependencies are out of date. Run \`make install\`, then start the daemon again.` : undefined;
}

/** The last few kilobytes of a log, or nothing when it cannot be read. */
export function readTail(path: string, bytes = 8192): string {
  try {
    return readFileSync(path, "utf8").slice(-bytes);
  } catch {
    return "";
  }
}
