/**
 * Command allowlist matching shared by adapters and the Policy Engine. Patterns are exact
 * commands (`npm test`) or prefixes ending in ` *` (`npm run *`).
 */

export type CommandPattern = { prefix: string; wildcard: boolean };

export function parsePattern(pattern: string): CommandPattern {
  const trimmed = pattern.trim();
  return trimmed.endsWith(" *")
    ? { prefix: trimmed.slice(0, -2).trim(), wildcard: true }
    : { prefix: trimmed, wildcard: false };
}

export function matchesPattern(command: string, pattern: string): boolean {
  const c = command.trim().replace(/\s+/g, " ");
  const p = parsePattern(pattern);
  if (!p.wildcard) return c === p.prefix;
  return c === p.prefix || c.startsWith(`${p.prefix} `);
}

export function isDenied(command: string, denyPrefixes: string[]): boolean {
  return denyPrefixes.some((prefix) => matchesPattern(command, `${prefix} *`));
}

/** Shell syntax that could chain or redirect commands past the allowlist. */
const SHELL_META = /[;&|`$<>(){}\n\\]/;

export function commandAllowed(command: string, allow: string[], deny: string[]): boolean {
  if (SHELL_META.test(command)) return false;
  if (isDenied(command, deny)) return false;
  return allow.some((pattern) => matchesPattern(command, pattern));
}
