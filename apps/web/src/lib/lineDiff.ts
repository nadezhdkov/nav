/** A line of a diff: kept, removed from `a`, or added from `b`. */
export type DiffLine = { kind: "same" | "del" | "add"; text: string; a?: number; b?: number };

/**
 * Line diff of two texts by longest common subsequence: enough for Flow documents of a few
 * hundred lines (the publish preview and lossless editing, ADR 0033).
 */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  // lcs[i][j]: length of the LCS of x[i..] and y[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) out.push({ kind: "same", text: x[i]!, a: i++, b: j++ });
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: "del", text: x[i]!, a: i++ });
    else out.push({ kind: "add", text: y[j]!, b: j++ });
  }
  while (i < n) out.push({ kind: "del", text: x[i]!, a: i++ });
  while (j < m) out.push({ kind: "add", text: y[j]!, b: j++ });
  return out;
}

/** Diff lines with `context` unchanged lines around each change; `null` marks a gap. */
export function hunks(diff: DiffLine[], context = 3): (DiffLine | null)[] {
  const keep = diff.map(() => false);
  diff.forEach((d, i) => {
    if (d.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  diff.forEach((d, i) => {
    if (keep[i]) out.push(d);
    else if (out.at(-1) !== null && out.length) out.push(null);
  });
  if (out.at(-1) === null) out.pop();
  return out;
}
