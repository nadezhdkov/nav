const STOP = new Set(
  "the a an and or of to in on for with from by is are was be it this that these those we you they should must can could would not no yes add fix make use using update change issue bug feature when then than into out as at if else do does did has have had its our your their file files code test tests run runs agent task".split(" "),
);

/**
 * Words of the task that may be names in the code, strongest first: backticked identifiers and
 * file names, then camelCase, PascalCase and snake_case words, then plain words of 4+ letters.
 */
export function taskTerms(rawTask: string, limit = 12): string[] {
  const task = rawTask.slice(0, 20_000);
  const out = new Map<string, number>();
  const add = (term: string, weight: number) => {
    const key = term.trim();
    if (key.length < 3 || STOP.has(key.toLowerCase())) return;
    out.set(key, Math.max(out.get(key) ?? 0, weight));
  };
  for (const m of task.matchAll(/`([^`\n]{2,80})`/g)) {
    const quoted = m[1]!;
    add(quoted, 4);
    for (const part of quoted.split(/[^A-Za-z0-9_]+/)) add(part, 3);
  }
  // Whitespace-split tokens with a bounded, anchored pattern: the task may quote an untrusted issue.
  for (const token of task.split(/[\s"'`()<>,;:]+/)) {
    if (token.length > 120 || !/^[\w./-]+\.(?:ts|tsx|js|jsx|vue|py|go|rs|md|ya?ml|json)$/.test(token)) continue;
    add(token, 4);
    add((token.split("/").pop() ?? "").replace(/\.[^.]+$/, ""), 2);
  }
  for (const m of task.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const w = m[0];
    if (/[a-z][A-Z]/.test(w) || /^[A-Z][a-z]+[A-Z]/.test(w) || w.includes("_")) add(w, 3);
    else if (w.length >= 4) add(w, 1);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
}
