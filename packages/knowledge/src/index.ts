import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeSymbol, CompiledContext } from "@navarch/contracts";
import { findSymbols, indexSymbols, repoMap, searchText } from "@navarch/explorer";
import { taskTerms } from "./terms.ts";

export { taskTerms } from "./terms.ts";

export const DEFAULT_MAX_TOKENS = 4_000;
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
export async function compileContext(opts: { root: string; task: string; maxTokens?: number }): Promise<CompiledContext | undefined> {
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

export { renderAddendum, renderIndex, renderSpec, searchSpecs, verifyAddendum, verifyDrafts } from "./specs.ts";
export type { AddendumMeta, VerifiedAddendum, VerifiedChange } from "./specs.ts";
export { isTestFile, parseSpecClaims, traceability } from "./trace.ts";
