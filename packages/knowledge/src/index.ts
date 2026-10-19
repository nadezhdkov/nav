import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeSymbol, CompiledContext } from "@navarch/contracts";
import { findSymbols, indexSymbols, listFiles, repoMap, searchText } from "@navarch/explorer";
import { isTestFile } from "./trace.ts";
import { taskTerms } from "./terms.ts";

export { taskTerms } from "./terms.ts";

export const DEFAULT_MAX_TOKENS = 4_000;
/** `full` is the map, symbols, excerpts and mentions of ADR 0043; `lean` is only the files to open first (ADR 0070). */
export type ContextMode = "full" | "lean";
export const DEFAULT_LEAN_TOKENS = 600;
const MAX_LEAN_FILES = 6;
const CHARS_PER_TOKEN = 4;
const MAX_SYMBOLS = 15;
const MAX_EXCERPTS = 6;
const EXCERPT_LINES = 30;
const MAX_MENTIONS = 8;

/** The `<context>` block cannot be closed from inside by repository text. */
function neutralise(text: string): string {
  return text.replace(/<\/?context\b[^>]*>/gi, (tag) => tag.replace(/</g, "&lt;"));
}

/**
 * Compiles the context of a Task from the code index (spec §6.8.2, ADR 0043): a short map, the
 * symbols and excerpts that match the task's words, and mentions. No model is called. Returns
 * undefined when the root is not a readable git repository or nothing could be said.
 */
export async function compileContext(opts: { root: string; task: string; maxTokens?: number; mode?: ContextMode }): Promise<CompiledContext | undefined> {
  if (opts.mode === "lean") return compileLean({ ...opts, maxTokens: opts.maxTokens ?? DEFAULT_LEAN_TOKENS });
  const started = Date.now();
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const budget = maxTokens * CHARS_PER_TOKEN;
  let map;
  let symbols: CodeSymbol[];
  try {
    [map, symbols] = await Promise.all([repoMap(opts.root), indexSymbols(opts.root)]);
  } catch {
    return undefined;
  }
  if (map.files === 0) return undefined;

  const sources: string[] = [];
  const parts: string[] = [];
  let used = 0;
  const push = (raw: string, source?: string): boolean => {
    const text = neutralise(raw);
    if (used + text.length + 1 > budget) return false;
    parts.push(text);
    used += text.length + 1;
    if (source && !sources.includes(source)) sources.push(source);
    return true;
  };

  const langs = map.languages.slice(0, 4).map((l) => `${l.lang} (${l.files} files)`).join(", ");
  const mapLines = [
    "## Map",
    `${map.files} files. Languages: ${langs || "unknown"}.`,
    ...(map.frameworks.length ? [`Frameworks and tools: ${map.frameworks.slice(0, 10).join(", ")}.`] : []),
    ...(map.entry_points.length ? [`Entry points: ${map.entry_points.slice(0, 6).join(", ")}.`] : []),
    `Top directories: ${map.directories.slice(0, 10).map((d) => `${d.path} (${d.files})`).join(", ")}.`,
  ];
  push(mapLines.join("\n"));

  const terms = taskTerms(opts.task);
  const seen = new Set<string>();
  const matched: CodeSymbol[] = [];
  for (const term of terms) {
    for (const s of findSymbols(symbols, term, { limit: 6 })) {
      const key = `${s.file}:${s.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matched.push(s);
    }
    if (matched.length >= MAX_SYMBOLS) break;
  }
  const top = matched.slice(0, MAX_SYMBOLS);
  if (top.length) {
    const lines = top.map((s) => `- ${s.kind} \`${s.name}\`${s.exported ? " (exported)" : ""} — ${s.file}:${s.line}`);
    if (push(["## Symbols matching the task", ...lines].join("\n"))) for (const s of top) sources.push(`${s.file}:${s.line}`);
  }

  let excerpts = 0;
  const files = new Map<string, string[]>();
  for (const s of top) {
    if (excerpts >= MAX_EXCERPTS) break;
    let lines = files.get(s.file);
    if (!lines) {
      try {
        lines = (await readFile(join(opts.root, s.file), "utf8")).split("\n");
      } catch {
        continue;
      }
      files.set(s.file, lines);
    }
    const slice = lines.slice(s.line - 1, s.line - 1 + EXCERPT_LINES);
    const numbered = slice.map((l, i) => `${s.line + i}: ${l.length > 200 ? `${l.slice(0, 200)}…` : l}`).join("\n");
    if (!push(`## ${s.file}:${s.line}\n${numbered}`)) break;
    excerpts++;
  }

  const strongest = terms[0];
  if (strongest) {
    try {
      const declared = new Set(top.map((s) => `${s.file}:${s.line}`));
      const hits = (await searchText(opts.root, strongest)).filter((h) => !declared.has(`${h.file}:${h.line}`)).slice(0, MAX_MENTIONS);
      if (hits.length) push(["## Mentions of `" + strongest + "`", ...hits.map((h) => `- ${h.file}:${h.line}: ${h.text.trim()}`)].join("\n"));
    } catch {
      // Search is an extra; the rest of the context stands without it.
    }
  }

  const text = parts.join("\n\n");
  return { text, sources, chars: text.length, est_tokens: Math.ceil(text.length / CHARS_PER_TOKEN), max_tokens: maxTokens, ms: Date.now() - started };
}

/**
 * The lean block (ADR 0070): the few files that most likely hold the work, each with the names the task's words
 * matched and the test file beside it. No excerpts, no map: an agent reads a file whole before it edits it, so an
 * excerpt only adds tokens, and studies of repository context files found that more context made agents explore
 * more, not less. The block points; it does not explain.
 */
async function compileLean(opts: { root: string; task: string; maxTokens: number }): Promise<CompiledContext | undefined> {
  const started = Date.now();
  const budget = opts.maxTokens * CHARS_PER_TOKEN;
  let symbols: CodeSymbol[];
  let files: string[];
  try {
    const [map, all] = await Promise.all([repoMap(opts.root), indexSymbols(opts.root)]);
    if (map.files === 0) return undefined;
    symbols = all;
    files = await listFiles(opts.root);
  } catch {
    return undefined;
  }
  const terms = taskTerms(opts.task, 8);
  const byFile = new Map<string, { score: number; names: Map<string, number> }>();
  terms.forEach((term, rank) => {
    // Earlier terms are stronger; a file that several terms reach outranks one a single term reaches.
    for (const s of findSymbols(symbols, term, { limit: 6 })) {
      const entry = byFile.get(s.file) ?? { score: 0, names: new Map<string, number>() };
      entry.score += (terms.length - rank) * (s.exported ? 1.5 : 1);
      if (!entry.names.has(s.name)) entry.names.set(s.name, s.line);
      byFile.set(s.file, entry);
    }
  });
  const ranked = [...byFile.entries()].filter(([file]) => !isTestFile(file)).sort((a, b) => b[1].score - a[1].score).slice(0, MAX_LEAN_FILES);
  if (!ranked.length) return undefined;

  const header = "## Files most likely involved (from a line-based index; a starting point, not the whole truth)";
  const sources: string[] = [];
  const lines: string[] = [];
  let used = header.length;
  for (const [file, { names }] of ranked) {
    const shown = [...names.entries()].slice(0, 4).map(([name, line]) => `${name}:${line}`).join(", ");
    const test = testBeside(file, files);
    const line = neutralise(`- ${file} (${shown})${test ? `; test: ${test}` : ""}`);
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
    sources.push(file);
  }
  if (!lines.length) return undefined;
  const text = [header, ...lines].join("\n");
  return { text, sources, chars: text.length, est_tokens: Math.ceil(text.length / CHARS_PER_TOKEN), max_tokens: opts.maxTokens, ms: Date.now() - started };
}

/** The test file named like `file` (`a/b.ts` → `a/b.test.ts`, `test_b.py`, `b_test.go`), when the repository has one. */
function testBeside(file: string, files: string[]): string | undefined {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return undefined;
  const stem = file.slice(0, dot);
  const ext = file.slice(dot);
  const base = stem.split("/").pop()!;
  const dir = stem.slice(0, stem.length - base.length);
  const wanted = new Set([`${stem}.test${ext}`, `${stem}.spec${ext}`, `${dir}test_${base}${ext}`, `${stem}_test${ext}`, `${dir}test/${base}.test${ext}`, `${dir}tests/${base}.test${ext}`]);
  return files.find((f) => wanted.has(f));
}

export { renderAddendum, renderIndex, renderSpec, searchSpecs, verifyAddendum, verifyDrafts } from "./specs.ts";
export type { AddendumMeta, VerifiedAddendum, VerifiedChange } from "./specs.ts";
export { isTestFile, parseSpecClaims, traceability } from "./trace.ts";
